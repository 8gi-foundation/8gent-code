/**
 * llamacpp backend tests. Offline and without node-llama-cpp: the dynamic
 * import is replaced by an injected loader returning a fake module with a
 * tiny vocabulary, and GGUF resolution runs against a temp Ollama store.
 */

import { afterAll, afterEach, describe, expect, it, setSystemTime } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _resetSystemOne, _setSystemOneOverridesForTests, systemOneGate } from "../../permissions/system-one-gate";
import * as decideIndex from "../index";
import { DecideError, DecideUnavailableError, createDecider, detectBackend } from "../index";
import { SHARED_JUDGE_NUM_CTX } from "../probe";
import {
	LlamaCppBackend,
	type LlamaCppLoader,
	type LlamaModelLike,
	type NodeLlamaCppModule,
	candidateTokens,
	disposeLlamaCpp,
	labelSpellings,
	listOllamaGgufs,
	llamaCppUnavailable,
	loadedLlamaCppEngines,
	logprobsFromLogits,
	manifestName,
	ollamaModelsDir,
	resolveGguf,
} from "./llamacpp";
import { distributionFromLogprobs } from "./ollama";

// ----- fake node-llama-cpp -----------------------------------------------------

const BOS = 0;
/** Tiny vocabulary. Anything else tokenizes one char per token (ids 1000+). */
const VOCAB = [
	"<bos>",
	" Yes",
	"Yes",
	" yes",
	" No",
	"No",
	" no",
	" A",
	" B",
	" C",
	" a",
	" ",
	"1",
	"2",
	"3",
	" 1",
	"\n",
];
const ID = new Map(VOCAB.map((t, i) => [t, i]));

function tokenize(text: string): number[] {
	const hit = ID.get(text);
	if (hit !== undefined && text !== "<bos>") return [hit];
	return [...text].map((c) => 1000 + c.charCodeAt(0));
}

function detokenize(tokens: readonly number[]): string {
	return tokens.map((t) => (t < 1000 ? VOCAB[t] : String.fromCharCode(t - 1000))).join("");
}

/** Next-token logits as a function of the whole evaluated token list. */
type Scorer = (tokens: number[]) => Map<number, number>;

interface FakeStats {
	getLlama: number;
	loadModel: number;
	createContext: number;
	clearHistory: number;
	evaluated: number[][];
	disposed: string[];
	getLlamaOpts: Array<Record<string, unknown> | undefined>;
}

function fakeModule(scorer: Scorer, stats: FakeStats): NodeLlamaCppModule {
	return {
		LlamaLogLevel: { error: "error" },
		async getLlama(opts) {
			stats.getLlama++;
			stats.getLlamaOpts.push(opts);
			return {
				async loadModel() {
					stats.loadModel++;
					const model: LlamaModelLike = {
						tokenize: (text) => tokenize(text),
						detokenize: (tokens) => detokenize(tokens),
						tokens: { bos: BOS, shouldPrependBosToken: true },
						async createContext() {
							stats.createContext++;
							return {
								getSequence: () => ({
									async clearHistory() {
										stats.clearHistory++;
									},
									async controlledEvaluate(input) {
										const flat = input.map((x) => (Array.isArray(x) ? x[0] : x));
										stats.evaluated.push(flat);
										const last = input[input.length - 1];
										if (!Array.isArray(last)) throw new Error("last input must request generateNext");
										const all = scorer(flat);
										const wanted = new Set(last[1].generateNext.logits.filter.tokens);
										const top = [...all.entries()].sort((a, b) => b[1] - a[1]).slice(0, last[1].generateNext.logits.filter.includeTop);
										const logits = new Map<number, number>();
										for (const [id, l] of all) if (wanted.has(id)) logits.set(id, l);
										for (const [id, l] of top) logits.set(id, l);
										const max = Math.max(...all.values());
										let total = 0;
										for (const l of all.values()) total += Math.exp(l - max);
										return [...flat.slice(0, -1).map(() => undefined), { next: { logits, totalLogitWeight: total } }];
									},
								}),
								async dispose() {
									stats.disposed.push("context");
								},
							};
						},
						async dispose() {
							stats.disposed.push("model");
						},
					};
					return model;
				},
				async dispose() {
					stats.disposed.push("llama");
				},
			};
		},
	};
}

function newStats(): FakeStats {
	return { getLlama: 0, loadModel: 0, createContext: 0, clearHistory: 0, evaluated: [], disposed: [], getLlamaOpts: [] };
}

function loaderFor(scorer: Scorer, stats = newStats()): { loader: LlamaCppLoader; stats: FakeStats } {
	return { loader: async () => fakeModule(scorer, stats), stats };
}

const missingLoader: LlamaCppLoader = async () => {
	throw new Error("Cannot find package 'node-llama-cpp'");
};

/** Build logits from probabilities (log p), every other token gets `rest` spread thin. */
function logitsFrom(probs: Record<string, number>, rest = 1e-6): Map<number, number> {
	const m = new Map<number, number>();
	for (const [tok, p] of Object.entries(probs)) m.set(ID.get(tok) as number, Math.log(p));
	for (let i = 1; i < VOCAB.length; i++) if (!m.has(i)) m.set(i, Math.log(rest));
	return m;
}

const close = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps);

// ----- temp files --------------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "decide-llamacpp-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
afterEach(async () => {
	await disposeLlamaCpp();
});

function writeGguf(file: string): string {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, Buffer.concat([Buffer.from("GGUF", "latin1"), Buffer.alloc(12)]));
	return file;
}

let storeSeq = 0;
/** A fake Ollama store: manifests plus blobs. `mlx` entries get a non-GGUF blob. */
function makeStore(models: Array<{ registry: string; ns: string; repo: string; tag: string; size: number; mlx?: boolean }>): string {
	const dir = path.join(tmp, `store-${storeSeq++}`);
	for (const [i, m] of models.entries()) {
		const digest = `sha256:${String(i).padStart(64, "0")}`;
		const blob = path.join(dir, "blobs", digest.replace(":", "-"));
		if (m.mlx) {
			fs.mkdirSync(path.dirname(blob), { recursive: true });
			fs.writeFileSync(blob, "not a gguf");
		} else {
			writeGguf(blob);
		}
		const manifest = path.join(dir, "manifests", m.registry, m.ns, m.repo, m.tag);
		fs.mkdirSync(path.dirname(manifest), { recursive: true });
		fs.writeFileSync(
			manifest,
			JSON.stringify({
				layers: [
					{ mediaType: "application/vnd.ollama.image.template", digest: `sha256:${"f".repeat(64)}`, size: 10 },
					{ mediaType: "application/vnd.ollama.image.model", digest, size: m.size },
				],
			}),
		);
	}
	return dir;
}

const SELENE = { registry: "hf.co", ns: "AtlaAI", repo: "Selene-1-Mini-Llama-3.1-8B-Q4_K_M-GGUF", tag: "latest", size: 4_900 };
const LLAMA32 = { registry: "registry.ollama.ai", ns: "library", repo: "llama3.2", tag: "3b", size: 2_000 };
const MLX = { registry: "registry.ollama.ai", ns: "library", repo: "qwen3.8", tag: "27b-mlx", size: 18_000, mlx: true };
const SELENE_NAME = "hf.co/AtlaAI/Selene-1-Mini-Llama-3.1-8B-Q4_K_M-GGUF:latest";

// ----- GGUF resolution ---------------------------------------------------------

describe("llamacpp GGUF resolution", () => {
	it("names manifests the way Ollama does", () => {
		expect(manifestName("registry.ollama.ai", "library", "llama3.2", "3b")).toBe("llama3.2:3b");
		expect(manifestName("registry.ollama.ai", "openbmb", "minicpm5", "latest")).toBe("openbmb/minicpm5:latest");
		expect(manifestName("hf.co", "AtlaAI", SELENE.repo, "latest")).toBe(SELENE_NAME);
	});

	it("lists only models whose model layer is a GGUF on disk", () => {
		const store = makeStore([SELENE, LLAMA32, MLX]);
		const names = listOllamaGgufs(store).map((m) => m.name);
		expect(names).toContain(SELENE_NAME);
		expect(names).toContain("llama3.2:3b");
		expect(names).not.toContain("qwen3.8:27b-mlx");
	});

	it("prefers Selene from the store, honours EIGHT_DECIDE_MODEL when installed", () => {
		const store = makeStore([LLAMA32, SELENE, MLX]);
		const r = resolveGguf({ OLLAMA_MODELS: store });
		expect(r.model).toBe(SELENE_NAME);
		expect(r.path && fs.existsSync(r.path)).toBe(true);
		expect(resolveGguf({ OLLAMA_MODELS: store, EIGHT_DECIDE_MODEL: "llama3.2:3b" }).model).toBe("llama3.2:3b");
		expect(resolveGguf({ OLLAMA_MODELS: store }, "llama3.2:3b").model).toBe("llama3.2:3b");
	});

	it("never substitutes a different model for an explicitly requested one", () => {
		const store = makeStore([LLAMA32, SELENE, MLX]);
		for (const r of [
			resolveGguf({ OLLAMA_MODELS: store }, "not-installed"),
			resolveGguf({ OLLAMA_MODELS: store, EIGHT_DECIDE_MODEL: "qwen3.8:27b-mlx" }),
			resolveGguf({ OLLAMA_MODELS: store }, "qwen3.8:27b-mlx"),
		]) {
			expect(r.path).toBeNull();
			expect(r.model).toBeNull();
			expect(r.path === null && r.note).toContain("not installed as a GGUF");
		}
		// ":latest" is still the same model.
		expect(resolveGguf({ OLLAMA_MODELS: store }, SELENE_NAME.replace(/:latest$/, "")).model).toBe(SELENE_NAME);
	});

	it("EIGHT_DECIDE_GGUF wins and must be a GGUF", () => {
		const file = writeGguf(path.join(tmp, "explicit", "model.gguf"));
		const r = resolveGguf({ EIGHT_DECIDE_GGUF: file, OLLAMA_MODELS: makeStore([SELENE]) });
		expect(r).toEqual({ path: file, model: "model.gguf", source: "env" });
		const bad = resolveGguf({ EIGHT_DECIDE_GGUF: path.join(tmp, "nope.gguf") });
		expect(bad.path).toBeNull();
		expect(bad.path === null && bad.note).toContain("EIGHT_DECIDE_GGUF");
	});

	it("looks only where the given env points (HOME or OLLAMA_MODELS)", () => {
		expect(ollamaModelsDir({})).toBeNull();
		expect(resolveGguf({})).toEqual({ path: null, model: null, note: null });
		expect(ollamaModelsDir({ HOME: "/h" })).toBe(path.join("/h", ".ollama", "models"));
		const empty = resolveGguf({ OLLAMA_MODELS: path.join(tmp, "missing-store") });
		expect(empty.path === null && empty.note).toContain("no GGUF model");
	});
});

// ----- token mapping -----------------------------------------------------------

describe("llamacpp token mapping", () => {
	const model = {
		tokenize: (t: string) => tokenize(t),
		detokenize: (t: readonly number[]) => detokenize(t),
		tokens: { bos: BOS, shouldPrependBosToken: true },
	} as unknown as LlamaModelLike;

	it("finds every single-token spelling of the labels", () => {
		const yesNo = candidateTokens(model, "noul", ["yes", "no"]);
		for (const t of [" Yes", "Yes", " yes", " No", "No", " no"]) expect(yesNo).toContain(ID.get(t) as number);
		expect(labelSpellings("choice", ["A"])).not.toContain("a");
		const letters = candidateTokens(model, "choice", ["A", "B", "C"]);
		for (const t of [" A", " B", " C"]) expect(letters).toContain(ID.get(t) as number);
		expect(letters).not.toContain(ID.get(" a") as number);
	});

	it("turns logits into true logprobs using the whole-vocabulary weight", () => {
		const logits = new Map([
			[1, Math.log(0.6)],
			[4, Math.log(0.2)],
		]);
		// Whole vocab: 0.6 + 0.2 + 0.2 elsewhere; weight is relative to the max (0.6).
		const lp = logprobsFromLogits(model, logits, 1 / 0.6);
		close(Math.exp(lp[0].logprob), 0.6);
		close(Math.exp(lp[1].logprob), 0.2);
		expect(lp[0].token).toBe(" Yes");
		expect(lp[0].id).toBe(1);
	});
});

// ----- backend -----------------------------------------------------------------

describe("LlamaCppBackend", () => {
	const gguf = writeGguf(path.join(tmp, "backend", "m.gguf"));

	it("noul: sums spelling variants and renormalises like the Ollama backend", async () => {
		const probs = { " Yes": 0.5, Yes: 0.1, " No": 0.2, " no": 0.05, "\n": 0.1 };
		const { loader, stats } = loaderFor(() => logitsFrom(probs));
		const b = new LlamaCppBackend({ model: SELENE_NAME, modelPath: gguf, loader });
		const r = await b.ask({ state: "ls", questions: [{ id: "q", kind: "noul", prompt: "Destructive?" }] });
		const a = r.answers[0];
		if (a.kind !== "noul") throw new Error("kind");
		close(a.probabilities.yes, 0.6 / 0.85, 1e-6);
		expect(r.backend).toBe("llamacpp");
		expect(r.model).toBe(SELENE_NAME);
		// Same answer as the Ollama path fed the same mass as top_logprobs.
		const ollama = distributionFromLogprobs(
			"noul",
			["yes", "no"],
			Object.entries(probs).map(([token, p]) => ({ token, logprob: Math.log(p) })),
		);
		close(a.probabilities.yes, ollama[0], 1e-5);
		// BOS prepended, prompt ends at the answer slot.
		const evaluated = stats.evaluated[0];
		expect(evaluated[0]).toBe(BOS);
		expect(detokenize(evaluated.slice(1))).toEndWith("Answer (yes or no):");
		expect(stats.getLlamaOpts[0]?.build).toBe("never");
	});

	it("choice: uppercase letters only, the article ' a' is not option A", async () => {
		const { loader } = loaderFor(() => logitsFrom({ " a": 0.5, " A": 0.1, " B": 0.3 }));
		const b = new LlamaCppBackend({ model: "m", modelPath: gguf, loader });
		const r = await b.ask({ state: "s", questions: [{ id: "c", kind: "choice", prompt: "Pick", options: ["x", "y", "z"] }] });
		const a = r.answers[0];
		if (a.kind !== "choice") throw new Error("kind");
		expect(a.chosen).toBe(1);
		close(a.probabilities[0], 0.1 / (0.1 + 0.3 + 1e-6), 1e-4);
	});

	it("score: a pure-whitespace lead token is committed and the next token read", async () => {
		const space = ID.get(" ") as number;
		const { loader, stats } = loaderFor((tokens) =>
			// Before the space no digit is in the vocabulary's top tokens at all.
			tokens[tokens.length - 1] === space
				? logitsFrom({ "1": 0.1, "2": 0.2, "3": 0.7 }, 1e-9)
				: new Map([
						[space, Math.log(0.9)],
						[ID.get("\n") as number, Math.log(0.1)],
					]),
		);
		const b = new LlamaCppBackend({ model: "m", modelPath: gguf, loader });
		const r = await b.ask({ state: "s", questions: [{ id: "s", kind: "score", prompt: "Risk?", levels: ["low", "mid", "high"] }] });
		const a = r.answers[0];
		if (a.kind !== "score") throw new Error("kind");
		expect(a.chosen).toBe(2);
		close(a.confidence, 0.7, 1e-6);
		expect(stats.evaluated.length).toBe(2);
		expect(stats.evaluated[1][stats.evaluated[1].length - 1]).toBe(space);
		// Each evaluation starts from a clean sequence.
		expect(stats.clearHistory).toBe(2);
	});

	it("keeps one model and context loaded across calls and backends, disposes on demand", async () => {
		const { loader, stats } = loaderFor(() => logitsFrom({ " Yes": 0.3, " No": 0.7 }));
		const a = new LlamaCppBackend({ model: "m", modelPath: gguf, loader });
		const b = new LlamaCppBackend({ model: "m", modelPath: gguf, loader });
		const q = { state: "s", questions: [{ id: "q", kind: "noul" as const, prompt: "p" }] };
		const [r1, r2] = await Promise.all([a.ask(q), b.ask(q)]);
		await a.ask(q);
		expect(r1.answers).toEqual(r2.answers);
		expect(stats.getLlama).toBe(1);
		expect(stats.loadModel).toBe(1);
		expect(stats.createContext).toBe(1);
		expect(loadedLlamaCppEngines()).toBe(1);
		await disposeLlamaCpp();
		expect(stats.disposed).toEqual(["context", "model", "llama"]);
		expect(loadedLlamaCppEngines()).toBe(0);
	});

	it("is deterministic: same input gives identical probabilities", async () => {
		const { loader } = loaderFor((t) => logitsFrom({ " Yes": 0.01 * (t.length % 50), " No": 0.4 }));
		const b = new LlamaCppBackend({ model: "m", modelPath: gguf, loader });
		const q = { state: "rm -i x", questions: [{ id: "q", kind: "noul" as const, prompt: "p" }] };
		const first = (await b.ask(q)).answers;
		for (let i = 0; i < 5; i++) expect((await b.ask(q)).answers).toEqual(first);
	});

	it("caps choice at 26 options with a llamacpp error", async () => {
		const { loader } = loaderFor(() => logitsFrom({ " A": 1 }));
		const b = new LlamaCppBackend({ model: "m", modelPath: gguf, loader });
		const options = Array.from({ length: 27 }, (_, i) => `o${i}`);
		await expect(b.ask({ state: "s", questions: [{ id: "c", kind: "choice", prompt: "p", options }] })).rejects.toThrow(
			/llamacpp backend supports at most 26/,
		);
	});

	it("throws when no answer token has mass", async () => {
		const { loader } = loaderFor(() => new Map([[ID.get("\n") as number, 0]]));
		const b = new LlamaCppBackend({ model: "m", modelPath: gguf, loader });
		await expect(b.ask({ state: "s", questions: [{ id: "q", kind: "noul", prompt: "p" }] })).rejects.toThrow(DecideError);
	});

	it("reports a missing optional package as unavailable, and retries after a failed load", async () => {
		const b = new LlamaCppBackend({ model: "m", modelPath: gguf, loader: missingLoader });
		await expect(b.ask({ state: "s", questions: [{ id: "q", kind: "noul", prompt: "p" }] })).rejects.toThrow(DecideUnavailableError);
		expect(loadedLlamaCppEngines()).toBe(0);
		expect(await llamaCppUnavailable(missingLoader)).toContain("node-llama-cpp not installed");
		expect(await llamaCppUnavailable(loaderFor(() => new Map()).loader)).toBeNull();
	});
});

// ----- probe + createDecider ---------------------------------------------------

describe("llamacpp probe order", () => {
	const refused = async (url: string): Promise<Response> => {
		throw new TypeError(`fetch failed: ${url}`);
	};
	const layaUp = async (url: string): Promise<Response> => {
		if (url.endsWith("/health")) return new Response("{}", { status: 200 });
		throw new TypeError(`fetch failed: ${url}`);
	};

	it("picks llamacpp first when the package loads and a GGUF resolves", async () => {
		const store = makeStore([LLAMA32, SELENE]);
		const { loader } = loaderFor(() => new Map());
		const r = await detectBackend({ fetch: layaUp, env: { OLLAMA_MODELS: store }, llamacppLoader: loader });
		expect(r.backend).toBe("llamacpp");
		expect(r.model).toBe(SELENE_NAME);
		expect(r.path && fs.existsSync(r.path)).toBe(true);
		expect(r.url).toBeNull();
	});

	it("falls through to laya when the optional package is missing", async () => {
		const store = makeStore([SELENE]);
		const r = await detectBackend({ fetch: layaUp, env: { OLLAMA_MODELS: store }, llamacppLoader: missingLoader });
		expect(r.backend).toBe("laya");
		expect(r.notes[0]).toContain("node-llama-cpp not installed");
	});

	it("does not import the package when no GGUF resolves", async () => {
		let imported = 0;
		const loader: LlamaCppLoader = async () => {
			imported++;
			return fakeModule(() => new Map(), newStats());
		};
		const r = await detectBackend({ fetch: refused, env: { OLLAMA_MODELS: path.join(tmp, "none") }, llamacppLoader: loader });
		expect(imported).toBe(0);
		expect(r.backend).toBe("none");
		expect(r.notes[0]).toContain("llamacpp: no GGUF model");
	});

	it("null loader skips llamacpp entirely", async () => {
		const r = await detectBackend({ fetch: refused, env: { OLLAMA_MODELS: makeStore([SELENE]) }, llamacppLoader: null });
		expect(r.backend).toBe("none");
		expect(r.notes.some((n) => n.includes("llamacpp"))).toBe(false);
	});

	it("an explicit model that is not a GGUF skips llamacpp and is served by name, never substituted", async () => {
		const store = makeStore([SELENE, MLX]);
		const { loader } = loaderFor(() => new Map());
		const env = { OLLAMA_MODELS: store, EIGHT_DECIDE_MODEL: "qwen3.8:27b-mlx" };
		const ollamaUp = async (url: string): Promise<Response> => {
			if (url.endsWith("/api/tags")) {
				return Response.json({ models: [{ name: SELENE_NAME, size: 4_900 }, { name: "qwen3.8:27b-mlx", size: 18_000 }] });
			}
			throw new TypeError(`fetch failed: ${url}`);
		};
		const viaOllama = await detectBackend({ fetch: ollamaUp, env, llamacppLoader: loader });
		expect(viaOllama.backend).toBe("ollama");
		expect(viaOllama.model).toBe("qwen3.8:27b-mlx");
		expect(viaOllama.notes[0]).toContain("llamacpp:");
		expect(viaOllama.notes[0]).toContain("qwen3.8:27b-mlx");
		const viaLaya = await detectBackend({ fetch: layaUp, env, llamacppLoader: loader });
		expect(viaLaya.backend).toBe("laya");
		expect(viaLaya.model).toBe("qwen3.8:27b-mlx");
		const auto = createDecider({ fetch: ollamaUp, model: "qwen3.8:27b-mlx", env: { OLLAMA_MODELS: store }, llamacppLoader: loader });
		const b = await auto.backend();
		expect(b.name).toBe("ollama");
		const forced = createDecider({ backend: "llamacpp", model: "qwen3.8:27b-mlx", env: { OLLAMA_MODELS: store }, llamacppLoader: loader });
		await expect(forced.backend()).rejects.toThrow(/not installed as a GGUF/);
	});

	it("createDecider auto and forced llamacpp decide end to end with the fake", async () => {
		const store = makeStore([SELENE]);
		const { loader } = loaderFor(() => logitsFrom({ " Yes": 0.9, " No": 0.1 }));
		const auto = createDecider({ fetch: refused, env: { OLLAMA_MODELS: store }, llamacppLoader: loader });
		const a = await auto.noul("state", "p");
		expect(a.backend).toBe("llamacpp");
		expect(a.model).toBe(SELENE_NAME);
		close(a.probabilities.yes, 0.9, 1e-4);
		const forced = createDecider({ backend: "llamacpp", env: { OLLAMA_MODELS: store }, llamacppLoader: loader });
		expect((await forced.backend()).name).toBe("llamacpp");
	});

	it("forced llamacpp without the package or a GGUF is unavailable", async () => {
		const store = makeStore([SELENE]);
		const noPkg = createDecider({ backend: "llamacpp", env: { OLLAMA_MODELS: store }, llamacppLoader: missingLoader });
		await expect(noPkg.backend()).rejects.toThrow(DecideUnavailableError);
		const noGguf = createDecider({ backend: "llamacpp", env: {}, llamacppLoader: loaderFor(() => new Map()).loader });
		await expect(noGguf.backend()).rejects.toThrow(/llamacpp/);
	});
});

// ----- shared judge (EIGHT_S1_SHARED_JUDGE, #3162) ----------------------------

describe("shared judge: one judge per machine", () => {
	const LOCAL = "http://localhost:11434";
	/** A fake machine: one Ollama per host, each serving the listed models. Records every URL asked. */
	function machine(hosts: Record<string, string[] | "down">) {
		const seen: string[] = [];
		const generated: Array<Record<string, unknown>> = [];
		const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
			seen.push(url);
			for (const [host, models] of Object.entries(hosts)) {
				if (!url.startsWith(host)) continue;
				if (models === "down") throw new TypeError(`fetch failed: ${url}`);
				if (url === `${host}/api/tags`) return Response.json({ models: models.map((name, i) => ({ name, size: 1_000 + i })) });
				if (url === `${host}/api/generate`) {
					generated.push(JSON.parse(String(init?.body)));
					return Response.json({ logprobs: [{ top_logprobs: [{ token: " Yes", logprob: Math.log(0.9) }, { token: " No", logprob: Math.log(0.1) }] }] });
				}
			}
			throw new TypeError(`fetch failed: ${url}`);
		};
		return { fetch: fetchImpl, seen, generated };
	}

	it("with the flag, judges on the machine's shared server instead of loading a private copy", async () => {
		const store = makeStore([LLAMA32, SELENE]);
		let imported = 0;
		const loader: LlamaCppLoader = async () => {
			imported++;
			return fakeModule(() => new Map(), newStats());
		};
		const m = machine({ [LOCAL]: [SELENE_NAME, "llama3.2:3b"] });
		const r = await detectBackend({ fetch: m.fetch, env: { OLLAMA_MODELS: store, EIGHT_S1_SHARED_JUDGE: "1" }, llamacppLoader: loader });
		expect(r.backend).toBe("ollama");
		expect(r.model).toBe(SELENE_NAME);
		expect(r.url).toBe(LOCAL);
		// node-llama-cpp is never imported, so no 6 GB private copy.
		expect(imported).toBe(0);
		// createDecider builds the HTTP backend, and its calibration key is (ollama, Selene), which exists.
		const d = createDecider({ fetch: m.fetch, env: { OLLAMA_MODELS: store, EIGHT_S1_SHARED_JUDGE: "1" }, llamacppLoader: loader });
		const b = await d.backend();
		expect([b.name, b.model]).toEqual(["ollama", SELENE_NAME]);
		expect(fs.existsSync(path.join(import.meta.dir, "..", "calibration", `ollama-${SELENE_NAME.replace(/[/:]/g, "_")}.json`))).toBe(true);
	});

	it("without the flag nothing changes: llama.cpp in-process, the shared server is never asked", async () => {
		const store = makeStore([SELENE]);
		const { loader } = loaderFor(() => new Map());
		const m = machine({ [LOCAL]: [SELENE_NAME] });
		for (const flag of [undefined, "0", ""]) {
			const r = await detectBackend({ fetch: m.fetch, env: { OLLAMA_MODELS: store, EIGHT_S1_SHARED_JUDGE: flag }, llamacppLoader: loader });
			expect(r.backend).toBe("llamacpp");
		}
		expect(m.seen).toEqual([]);
	});

	it("stays on this machine when the chat model's OLLAMA_HOST points at another box", async () => {
		const store = makeStore([SELENE]);
		const { loader } = loaderFor(() => new Map());
		const remote = "http://127.0.0.1:21434";
		const m = machine({ [LOCAL]: [SELENE_NAME], [remote]: [SELENE_NAME, "qwen3.8:27b-mlx"] });
		const env = { OLLAMA_MODELS: store, EIGHT_S1_SHARED_JUDGE: "1", OLLAMA_HOST: remote, OLLAMA_BASE_URL: remote };
		const r = await detectBackend({ fetch: m.fetch, env, llamacppLoader: loader });
		expect(r.url).toBe(LOCAL);
		expect(m.seen.every((u) => u.startsWith(LOCAL))).toBe(true);
		// EIGHT_DECIDE_OLLAMA_HOST is the one knob that moves it, normalised like OLLAMA_HOST.
		const moved = await detectBackend({ fetch: m.fetch, env: { ...env, EIGHT_DECIDE_OLLAMA_HOST: "127.0.0.1:21434" }, llamacppLoader: loader });
		expect(moved.url).toBe(remote);
	});

	it("changes where the judge runs, never which model judges", async () => {
		// In-process would load Selene; the shared server only has llama3.2. Use Selene in-process.
		const store = makeStore([LLAMA32, SELENE]);
		const { loader } = loaderFor(() => new Map());
		const m = machine({ [LOCAL]: ["llama3.2:3b"] });
		const r = await detectBackend({ fetch: m.fetch, env: { OLLAMA_MODELS: store, EIGHT_S1_SHARED_JUDGE: "1" }, llamacppLoader: loader });
		expect(r.backend).toBe("llamacpp");
		expect(r.model).toBe(SELENE_NAME);
		expect(r.notes[0]).toContain(`does not serve ${SELENE_NAME}`);
	});

	it("falls back to in-process llama.cpp when the shared server is down", async () => {
		const store = makeStore([SELENE]);
		const { loader } = loaderFor(() => new Map());
		const m = machine({ [LOCAL]: "down" });
		const r = await detectBackend({ fetch: m.fetch, env: { OLLAMA_MODELS: store, EIGHT_S1_SHARED_JUDGE: "1" }, llamacppLoader: loader });
		expect(r.backend).toBe("llamacpp");
		expect(r.notes[0]).toContain("shared judge unreachable");
	});

	it("an explicit EIGHT_DECIDE_GGUF file stays in-process and the shared server is not asked", async () => {
		const file = writeGguf(path.join(tmp, "shared", "judge.gguf"));
		const { loader } = loaderFor(() => new Map());
		const m = machine({ [LOCAL]: [SELENE_NAME] });
		const r = await detectBackend({ fetch: m.fetch, env: { EIGHT_DECIDE_GGUF: file, EIGHT_S1_SHARED_JUDGE: "1" }, llamacppLoader: loader });
		expect(r.backend).toBe("llamacpp");
		expect(m.seen).toEqual([]);
	});

	it("with llama-server selected (EIGHT_LOCAL_SERVER), Ollama is off: the shared server is never asked", async () => {
		const store = makeStore([SELENE]);
		const { loader } = loaderFor(() => new Map());
		const m = machine({ [LOCAL]: [SELENE_NAME] });
		const env = { OLLAMA_MODELS: store, EIGHT_S1_SHARED_JUDGE: "1", EIGHT_LOCAL_SERVER: "llama-server" };
		const r = await detectBackend({ fetch: m.fetch, env, llamacppLoader: loader });
		expect(r.backend).toBe("llamacpp");
		expect(m.seen).toEqual([]);
	});

	it("with no GGUF on disk, picks the judge from what the shared server serves", async () => {
		const m = machine({ [LOCAL]: ["llama3.2:3b", SELENE_NAME] });
		const r = await detectBackend({
			fetch: m.fetch,
			env: { OLLAMA_MODELS: path.join(tmp, "none"), EIGHT_S1_SHARED_JUDGE: "1" },
			llamacppLoader: loaderFor(() => new Map()).loader,
		});
		expect([r.backend, r.model, r.url]).toEqual(["ollama", SELENE_NAME, LOCAL]);
	});

	it("pins the shared judge's context window; the unflagged Ollama path sends none", async () => {
		// Ollama 0.34 otherwise sizes Selene's context to free memory: 131072 tokens, 21.9 GB resident (#3162).
		const store = makeStore([SELENE]);
		const m = machine({ [LOCAL]: [SELENE_NAME] });
		const shared = createDecider({ fetch: m.fetch, env: { OLLAMA_MODELS: store, EIGHT_S1_SHARED_JUDGE: "1" }, llamacppLoader: missingLoader });
		const a = await shared.noul("state", "p");
		expect(a.backend).toBe("ollama");
		close(a.probabilities.yes, 0.9, 1e-4);
		expect((m.generated[0].options as Record<string, unknown>).num_ctx).toBe(SHARED_JUDGE_NUM_CTX);
		expect(SHARED_JUDGE_NUM_CTX).toBe(4096);
		m.generated.length = 0;
		const plain = createDecider({ fetch: m.fetch, env: { OLLAMA_MODELS: store }, llamacppLoader: missingLoader });
		await plain.noul("state", "p");
		expect(m.generated[0].options).toEqual({ temperature: 0, num_predict: 1, seed: 1 });
	});
});

// ----- lost shared judge (#3162 bar 4) -----------------------------------------

describe("shared judge failover: a lost shared judge recovers", () => {
	const LOCAL = "http://localhost:11434";
	const SAFE = logitsFrom({ " No": 0.95, " Yes": 0.05 });
	/** A local Ollama that can be taken away mid-test. Counts /api/tags (a probe) and /api/generate. */
	function server(models: string[]) {
		const state = { up: true, tags: 0, generate: 0, logprobs: true, probes: 0 };
		const fetchImpl = async (url: string): Promise<Response> => {
			// detectBackend asks laya's /health exactly once per probe (nothing listens there).
			if (url.endsWith("/health")) state.probes++;
			if (!url.startsWith(LOCAL)) throw new TypeError(`fetch failed: ${url}`);
			if (!state.up) throw new TypeError("fetch failed: ECONNREFUSED");
			if (url === `${LOCAL}/api/tags`) {
				state.tags++;
				return Response.json({ models: models.map((name, i) => ({ name, size: 1_000 + i })) });
			}
			state.generate++;
			if (!state.logprobs) return Response.json({ response: "x" });
			return Response.json({ logprobs: [{ top_logprobs: [{ token: " No", logprob: Math.log(0.8) }, { token: " Yes", logprob: Math.log(0.2) }] }] });
		};
		return { fetch: fetchImpl, state };
	}
	/** A fake node-llama-cpp that counts imports (one per probe, one per engine load). */
	function countingLoader(release?: Promise<void>) {
		const stats = newStats();
		const counts = { imports: 0 };
		const loader: LlamaCppLoader = async () => {
			counts.imports++;
			const mod = fakeModule(() => SAFE, stats);
			if (!release) return mod;
			// Model load waits for `release`, so a test can act while the fallback is still loading.
			return {
				...mod,
				async getLlama(o) {
					const llama = await mod.getLlama(o);
					return {
						...llama,
						loadModel: async (a) => {
							await release;
							return llama.loadModel(a);
						},
					};
				},
			};
		};
		return { loader, stats, counts };
	}
	const env = (store: string) => ({ OLLAMA_MODELS: store, EIGHT_S1_SHARED_JUDGE: "1" });
	// Read through the namespace so this file still loads against a tree without failover.
	const FAILOVER_BACKOFF_MS = decideIndex.FAILOVER_BACKOFF_MS ?? 2_000;

	afterEach(() => {
		setSystemTime();
		_resetSystemOne();
	});

	it("server down mid-session: the next verdict comes from the in-process judge", async () => {
		const store = makeStore([SELENE]);
		const srv = server([SELENE_NAME]);
		const { loader, stats } = countingLoader();
		const d = createDecider({ fetch: srv.fetch, env: env(store), llamacppLoader: loader });
		const before = await d.noul("state one", "p");
		expect(before.backend).toBe("ollama");
		expect(stats.loadModel).toBe(0);
		srv.state.up = false;
		const after = await d.noul("state two", "p");
		expect([after.backend, after.model]).toEqual(["llamacpp", SELENE_NAME]);
		close(after.probabilities.yes, 0.05, 1e-3);
		expect((await d.backend()).name).toBe("llamacpp");
		// It stays in-process for this session: no further shared calls.
		const generated = srv.state.generate;
		srv.state.up = true;
		expect((await d.noul("state three", "p")).backend).toBe("llamacpp");
		expect(srv.state.generate).toBe(generated);
	});

	it("a burst of concurrent verdicts during the outage triggers exactly one re-probe", async () => {
		const store = makeStore([SELENE]);
		const srv = server([SELENE_NAME]);
		const { loader, stats, counts } = countingLoader();
		const d = createDecider({ fetch: srv.fetch, env: env(store), llamacppLoader: loader });
		expect((await d.noul("warm", "p")).backend).toBe("ollama");
		srv.state.up = false;
		const imports = counts.imports;
		const tags = srv.state.tags;
		const burst = await Promise.all(Array.from({ length: 8 }, (_, i) => d.noul(`burst ${i}`, "p")));
		expect(burst.map((a) => a.backend)).toEqual(Array(8).fill("llamacpp"));
		// One re-probe (one node-llama-cpp import) plus one model load, not eight of either.
		expect(counts.imports - imports).toBe(2);
		expect(stats.loadModel).toBe(1);
		// In-process goes first after a loss, so the dead server is not even listed again.
		expect(srv.state.tags - tags).toBe(0);
	});

	it("with nothing to fail over to: one re-probe per burst, backed off, and the shared server is used again when it is back", async () => {
		const srv = server([SELENE_NAME]);
		const d = createDecider({ fetch: srv.fetch, env: { OLLAMA_MODELS: path.join(tmp, "none"), EIGHT_S1_SHARED_JUDGE: "1" }, llamacppLoader: missingLoader });
		expect((await d.noul("warm", "p")).backend).toBe("ollama");
		const probes = srv.state.probes;
		srv.state.up = false;
		const t0 = Date.now();
		setSystemTime(new Date(t0));
		const burst = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => d.noul(`down ${i}`, "p")));
		// Every verdict fails (the gate fails closed on it), and the machine is probed once, not eight times.
		expect(burst.every((r) => r.status === "rejected" && r.reason instanceof DecideUnavailableError)).toBe(true);
		expect(srv.state.probes - probes).toBe(1);
		// Inside the backoff window: no probe.
		setSystemTime(new Date(t0 + FAILOVER_BACKOFF_MS - 1));
		await expect(d.noul("backing off", "p")).rejects.toThrow(DecideUnavailableError);
		expect(srv.state.probes - probes).toBe(1);
		// After it: one more probe, and the window doubles.
		setSystemTime(new Date(t0 + FAILOVER_BACKOFF_MS + 1));
		await expect(d.noul("after window", "p")).rejects.toThrow(DecideUnavailableError);
		expect(srv.state.probes - probes).toBe(2);
		setSystemTime(new Date(t0 + FAILOVER_BACKOFF_MS + 1 + FAILOVER_BACKOFF_MS * 2 - 2));
		await expect(d.noul("doubled window", "p")).rejects.toThrow(DecideUnavailableError);
		expect(srv.state.probes - probes).toBe(2);
		// The shared server comes back: the session judges on it again.
		srv.state.up = true;
		expect((await d.noul("back again", "p")).backend).toBe("ollama");
	});

	it("a later session uses the shared server again once it is back", async () => {
		const store = makeStore([SELENE]);
		const srv = server([SELENE_NAME]);
		const { loader } = countingLoader();
		const first = createDecider({ fetch: srv.fetch, env: env(store), llamacppLoader: loader });
		await first.noul("a", "p");
		srv.state.up = false;
		expect((await first.noul("b", "p")).backend).toBe("llamacpp");
		srv.state.up = true;
		const later = createDecider({ fetch: srv.fetch, env: env(store), llamacppLoader: loader });
		expect((await later.noul("c", "p")).backend).toBe("ollama");
	});

	it("an answer the model gave but we cannot read never fails over", async () => {
		const store = makeStore([SELENE]);
		const srv = server([SELENE_NAME]);
		const { loader, counts } = countingLoader();
		const d = createDecider({ fetch: srv.fetch, env: env(store), llamacppLoader: loader });
		srv.state.logprobs = false;
		const err = await d.noul("s", "p").catch((e) => e);
		expect(err).toBeInstanceOf(DecideError);
		expect(err).not.toBeInstanceOf(DecideUnavailableError);
		expect(counts.imports).toBe(0);
		expect((await d.backend()).name).toBe("ollama");
	});

	it("without the flag nothing fails over: a private Ollama judge that dies stays failed", async () => {
		const srv = server([SELENE_NAME]);
		const { loader, counts } = countingLoader();
		const d = createDecider({ fetch: srv.fetch, env: { OLLAMA_MODELS: path.join(tmp, "none") }, llamacppLoader: loader });
		expect((await d.noul("a", "p")).backend).toBe("ollama");
		srv.state.up = false;
		await expect(d.noul("b", "p")).rejects.toThrow(DecideUnavailableError);
		expect(counts.imports).toBe(0);
	});

	it("strict gate: never allows while no judge is loaded, then judges in-process once the fallback is up", async () => {
		const store = makeStore([SELENE]);
		const srv = server([SELENE_NAME]);
		let release = () => {};
		const loaded = new Promise<void>((r) => {
			release = r;
		});
		const { loader } = countingLoader(loaded);
		const d = createDecider({ fetch: srv.fetch, env: env(store), llamacppLoader: loader });
		_setSystemOneOverridesForTests({ createDecider: () => d, askHuman: async () => null });
		const gateEnv = { EIGHT_SYSTEM_ONE: "1", EIGHT_S1_ALLOWLIST: "0", EIGHT_SYSTEM_ONE_TIMEOUT_MS: "150" };
		const before = await systemOneGate("ls -la", gateEnv);
		expect([before.run, before.guard?.backend]).toEqual([true, "ollama"]);
		srv.state.up = false;
		// The shared judge is gone and the in-process one is still loading: every verdict fails closed.
		for (const cmd of ["ls -la src", "git status", "cat README.md"]) {
			const r = await systemOneGate(cmd, gateEnv);
			expect(r.run).toBe(false);
			expect(r.guard?.backend).toBe("unavailable");
		}
		release();
		const after = await systemOneGate("ls -la docs", gateEnv);
		expect([after.run, after.guard?.backend, after.guard?.verdict]).toEqual([true, "llamacpp", "allow"]);
	});
});
