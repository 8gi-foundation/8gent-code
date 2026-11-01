/**
 * In-process llama.cpp backend via node-llama-cpp. No Ollama server needed.
 *
 * Same method as the Ollama backend, run in this process: the prompt from
 * `buildPrompt` (no chat template, like Ollama `raw: true`), one forward
 * pass, next-token logits read with `controlledEvaluate`, mass summed over
 * the spelling variants of each answer label and renormalised over the
 * labels only (`distributionFromLogprobs`). Nothing is sampled.
 *
 * node-llama-cpp is an OPTIONAL dependency and is imported dynamically, so
 * an install without it still works; the probe then reports llamacpp as
 * unavailable. The binding is loaded with `build: "never"`, so a missing
 * prebuilt binary fails instead of compiling from source.
 *
 * The GGUF comes from env EIGHT_DECIDE_GGUF, else from the documented
 * default folder `$HOME/.8gent/models/decide/*.gguf` (no Ollama needed,
 * #3149), else from the Ollama blob store (`$OLLAMA_MODELS` or
 * `$HOME/.ollama/models`) via the manifest of the chosen model. The model and context are loaded once per path (lazy
 * singleton), reused across calls, and disposed on process exit.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { type InstalledModel, pickModel } from "../probe";
import {
	type Answer,
	type DecideBackend,
	DecideError,
	DecideUnavailableError,
	type Question,
	type SystemOneRequest,
	type SystemOneResponse,
	answerFromDistribution,
	validateRequest,
} from "../types";
import {
	OLLAMA_MAX_CHOICE_OPTIONS,
	type TopLogprob,
	buildPrompt,
	distributionFromLogprobs,
	hasLabelMass,
	labelsFor,
} from "./ollama";

const TOP_TOKENS = 20;
const DEFAULT_CONTEXT_SIZE = 4096;
const OLLAMA_MODEL_LAYER = "application/vnd.ollama.image.model";
const OLLAMA_DEFAULT_REGISTRY = "registry.ollama.ai";

// ----- Structural view of the node-llama-cpp API we use ------------------------
// Kept local so this file typechecks without the optional package installed.

export interface LlamaSequenceLike {
	clearHistory(): Promise<void>;
	controlledEvaluate(
		input: Array<number | [number, { generateNext: { logits: { filter: { tokens: number[]; includeTop: number } }; totalLogitWeight: boolean } }]>,
	): Promise<Array<{ next?: { logits?: Map<number, number>; totalLogitWeight?: number } } | undefined>>;
}

export interface LlamaContextLike {
	getSequence(): LlamaSequenceLike;
	dispose(): Promise<void>;
}

export interface LlamaModelLike {
	tokenize(text: string, specialTokens?: boolean): number[];
	detokenize(tokens: readonly number[], specialTokens?: boolean): string;
	readonly tokens: { readonly bos: number | null; readonly shouldPrependBosToken: boolean };
	createContext(opts: { contextSize: number }): Promise<LlamaContextLike>;
	dispose(): Promise<void>;
}

export interface LlamaLike {
	loadModel(opts: { modelPath: string; gpuLayers?: "max" | "auto" | number }): Promise<LlamaModelLike>;
	dispose(): Promise<void>;
}

export interface NodeLlamaCppModule {
	getLlama(opts?: Record<string, unknown>): Promise<LlamaLike>;
	LlamaLogLevel?: { error?: unknown };
}

/** Loads the optional package. Injected in tests. */
export type LlamaCppLoader = () => Promise<NodeLlamaCppModule>;

// A variable specifier keeps the bundler and typechecker from resolving the optional package.
const PACKAGE = "node-llama-cpp";
export const defaultLlamaCppLoader: LlamaCppLoader = () => import(PACKAGE) as Promise<NodeLlamaCppModule>;

// ----- GGUF resolution ---------------------------------------------------------

export type Env = Record<string, string | undefined>;

export interface GgufModel extends InstalledModel {
	/** Absolute path to the GGUF blob. */
	path: string;
}

export type GgufResolution =
	| { path: string; model: string; source: "env" | "local" | "ollama"; note?: undefined }
	/** `note` is null when there is nowhere to look (no EIGHT_DECIDE_GGUF, OLLAMA_MODELS or HOME). */
	| { path: null; model: null; note: string | null };

/** System One's own GGUF folder, $HOME/.8gent/models/decide, from the given env only. */
export function decideModelsDir(env: Env): string | null {
	return env.HOME?.trim() ? path.join(env.HOME.trim(), ".8gent", "models", "decide") : null;
}

/**
 * Every `*.gguf` file directly in `dir` that really is a GGUF, named by its
 * file name without the extension. The Ollama-free way to give System One a
 * model: drop a GGUF in ~/.8gent/models/decide (#3149).
 */
export function listLocalGgufs(dir: string): GgufModel[] {
	let names: string[] = [];
	try {
		names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".gguf")).sort();
	} catch {
		return [];
	}
	return names.flatMap((n) => {
		const file = path.join(dir, n);
		if (!isGguf(file)) return [];
		let size: number | undefined;
		try {
			size = fs.statSync(file).size;
		} catch {}
		return [{ name: n.replace(/\.gguf$/i, ""), size, path: file }];
	});
}

/** Ollama models dir from the given env only (never the real home dir, so tests stay hermetic). */
export function ollamaModelsDir(env: Env): string | null {
	if (env.OLLAMA_MODELS?.trim()) return env.OLLAMA_MODELS.trim();
	if (env.HOME?.trim()) return path.join(env.HOME.trim(), ".ollama", "models");
	return null;
}

function isGguf(file: string): boolean {
	try {
		const fd = fs.openSync(file, "r");
		try {
			const buf = Buffer.alloc(4);
			return fs.readSync(fd, buf, 0, 4, 0) === 4 && buf.toString("latin1") === "GGUF";
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return false;
	}
}

function listDirs(dir: string): string[] {
	try {
		return fs
			.readdirSync(dir, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => d.name)
			.sort();
	} catch {
		return [];
	}
}

/** Ollama display name for manifests/<registry>/<namespace>/<repo>/<tag>. */
export function manifestName(registry: string, namespace: string, repo: string, tag: string): string {
	if (registry === OLLAMA_DEFAULT_REGISTRY) {
		return namespace === "library" ? `${repo}:${tag}` : `${namespace}/${repo}:${tag}`;
	}
	return `${registry}/${namespace}/${repo}:${tag}`;
}

/**
 * Every installed Ollama model whose model layer is a GGUF blob present on
 * disk. MLX and other non-GGUF formats are skipped.
 */
export function listOllamaGgufs(modelsDir: string): GgufModel[] {
	const manifests = path.join(modelsDir, "manifests");
	const out: GgufModel[] = [];
	for (const registry of listDirs(manifests)) {
		for (const ns of listDirs(path.join(manifests, registry))) {
			for (const repo of listDirs(path.join(manifests, registry, ns))) {
				const repoDir = path.join(manifests, registry, ns, repo);
				let tags: string[] = [];
				try {
					tags = fs.readdirSync(repoDir).sort();
				} catch {
					continue;
				}
				for (const tag of tags) {
					try {
						const manifest = JSON.parse(fs.readFileSync(path.join(repoDir, tag), "utf8")) as {
							layers?: Array<{ mediaType?: string; digest?: string; size?: number }>;
						};
						const layer = manifest.layers?.find((l) => l?.mediaType === OLLAMA_MODEL_LAYER);
						if (!layer?.digest || !/^sha256:[0-9a-f]{64}$/.test(layer.digest)) continue;
						const blob = path.join(modelsDir, "blobs", layer.digest.replace(":", "-"));
						if (!isGguf(blob)) continue;
						out.push({ name: manifestName(registry, ns, repo, tag), size: layer.size, path: blob });
					} catch {
						// Unreadable or non-JSON manifest: not a usable model.
					}
				}
			}
		}
	}
	return out;
}

/**
 * Resolve the GGUF to load. EIGHT_DECIDE_GGUF wins (and must exist). Else
 * the Ollama store: `modelOverride` (or env EIGHT_DECIDE_MODEL) if it is
 * installed as a GGUF. An explicitly requested model is never substituted:
 * when it has no GGUF (not installed, or MLX-only) this returns no path, so
 * the probe moves on to backends that serve it by name. Only with no
 * explicit model does `pickModel`'s preference order (Selene first) apply.
 */
export function resolveGguf(env: Env, modelOverride?: string): GgufResolution {
	const explicit = env.EIGHT_DECIDE_GGUF?.trim();
	const requested = modelOverride || env.EIGHT_DECIDE_MODEL;
	if (explicit) {
		if (!isGguf(explicit)) return { path: null, model: null, note: `EIGHT_DECIDE_GGUF is not a readable GGUF file: ${explicit}` };
		return { path: explicit, model: requested || path.basename(explicit), source: "env" };
	}
	// The documented folder first, then the Ollama store. Reading the store is
	// file access only; it never needs Ollama running.
	const localDir = decideModelsDir(env);
	const local = localDir ? listLocalGgufs(localDir) : [];
	const dir = ollamaModelsDir(env);
	if (!dir && local.length === 0) return { path: null, model: null, note: null };
	const fromOllama = dir ? listOllamaGgufs(dir) : [];
	const installed = [...local, ...fromOllama];
	const where = [localDir, dir && `the Ollama store at ${dir}`].filter(Boolean).join(" or ");
	const source = (m: GgufModel): "local" | "ollama" => (local.includes(m) ? "local" : "ollama");
	if (requested) {
		const name = pickModel(installed, requested);
		const hit = installed.find((m) => m.name === name && (name === requested || name === `${requested}:latest`));
		if (!hit) return { path: null, model: null, note: `${requested} is not installed as a GGUF in ${where}` };
		return { path: hit.path, model: hit.name, source: source(hit) };
	}
	const name = pickModel(installed);
	const hit = name ? installed.find((m) => m.name === name) : undefined;
	if (!hit) return { path: null, model: null, note: `no GGUF model in ${where}` };
	return { path: hit.path, model: hit.name, source: source(hit) };
}

/** Why the optional package cannot be used, or null when it loads. */
export async function llamaCppUnavailable(loader: LlamaCppLoader = defaultLlamaCppLoader): Promise<string | null> {
	try {
		const mod = await loader();
		if (typeof mod?.getLlama !== "function") return "node-llama-cpp loaded but has no getLlama export";
		return null;
	} catch (err) {
		return `node-llama-cpp not installed (optional dependency): ${(err as Error).message}`;
	}
}

// ----- Engine singleton --------------------------------------------------------

interface Engine {
	llama: LlamaLike;
	model: LlamaModelLike;
	context: LlamaContextLike;
	sequence: LlamaSequenceLike;
	/** Tail of the call queue: one evaluation at a time on the single sequence. */
	tail: Promise<unknown>;
	/** Candidate answer token ids per label set, computed once. */
	candidates: Map<string, number[]>;
}

const engines = new Map<string, Promise<Engine>>();
let exitHooked = false;

async function openEngine(modelPath: string, loader: LlamaCppLoader, contextSize: number): Promise<Engine> {
	const mod = await loader().catch((err: Error) => {
		throw new DecideUnavailableError(`node-llama-cpp not installed (optional dependency): ${err.message}`);
	});
	// build "never": use the prebuilt binary or fail; never compile from source at runtime.
	const llama = await mod.getLlama({ build: "never", logLevel: mod.LlamaLogLevel?.error ?? "error" });
	try {
		const model = await llama.loadModel({ modelPath, gpuLayers: "max" });
		const context = await model.createContext({ contextSize });
		return { llama, model, context, sequence: context.getSequence(), tail: Promise.resolve(), candidates: new Map() };
	} catch (err) {
		await llama.dispose().catch(() => {});
		throw err;
	}
}

function getEngine(modelPath: string, loader: LlamaCppLoader, contextSize: number): Promise<Engine> {
	let pending = engines.get(modelPath);
	if (!pending) {
		pending = openEngine(modelPath, loader, contextSize);
		engines.set(modelPath, pending);
		// A failed load must not poison later calls.
		pending.catch(() => {
			if (engines.get(modelPath) === pending) engines.delete(modelPath);
		});
		if (!exitHooked) {
			exitHooked = true;
			process.once("beforeExit", () => {
				void disposeLlamaCpp();
			});
			process.once("exit", () => {
				void disposeLlamaCpp();
			});
		}
	}
	return pending;
}

/** Dispose every loaded model and context. Safe to call more than once. */
export async function disposeLlamaCpp(): Promise<void> {
	const all = [...engines.values()];
	engines.clear();
	for (const pending of all) {
		const engine = await pending.catch(() => null);
		if (!engine) continue;
		await engine.tail.catch(() => {});
		await engine.context.dispose().catch(() => {});
		await engine.model.dispose().catch(() => {});
		await engine.llama.dispose().catch(() => {});
	}
}

/** Number of engines currently loaded or loading. For tests. */
export function loadedLlamaCppEngines(): number {
	return engines.size;
}

// ----- Token helpers -----------------------------------------------------------

/** A logprob entry that also carries its token id, sorted most likely first. */
export type ScoredToken = TopLogprob & { id: number };

const PREFIXES = ["", " ", "(", " (", '"', ' "', "*", " *"];
const SUFFIXES = ["", ".", ")", ":", ","];

/** The spellings tried for each label; `distributionFromLogprobs` decides what matches. */
export function labelSpellings(kind: Question["kind"], labels: string[]): string[] {
	const words = labels.flatMap((l) => (kind === "noul" ? [l, l[0].toUpperCase() + l.slice(1), l.toUpperCase()] : [l]));
	const out = new Set<string>();
	for (const w of words) for (const p of PREFIXES) for (const s of SUFFIXES) out.add(`${p}${w}${s}`);
	return [...out];
}

/** Token ids of every spelling that is a single token in this vocabulary. */
export function candidateTokens(model: LlamaModelLike, kind: Question["kind"], labels: string[]): number[] {
	const ids = new Set<number>();
	for (const s of labelSpellings(kind, labels)) {
		const t = model.tokenize(s, false);
		if (t.length === 1) ids.add(t[0]);
	}
	return [...ids].sort((a, b) => a - b);
}

/**
 * Turn filtered logits into logprobs. `totalLogitWeight` is the sum of
 * exp(logit - maxLogit) over the whole vocabulary, so each entry is a true
 * log probability, comparable with Ollama's `top_logprobs`.
 */
export function logprobsFromLogits(model: LlamaModelLike, logits: Map<number, number>, totalLogitWeight: number): ScoredToken[] {
	let max = Number.NEGATIVE_INFINITY;
	for (const l of logits.values()) if (l > max) max = l;
	const logTotal = Math.log(totalLogitWeight);
	return [...logits.entries()]
		.sort((a, b) => b[1] - a[1] || a[0] - b[0])
		.map(([id, l]) => ({ token: model.detokenize([id], false), logprob: l - max - logTotal, id }));
}

// ----- Backend -----------------------------------------------------------------

export interface LlamaCppBackendOptions {
	/** Absolute path to the GGUF file. */
	modelPath: string;
	/** Model label reported in responses (the Ollama name when resolved from the store). */
	model: string;
	/** Default 4096 tokens. */
	contextSize?: number;
	loader?: LlamaCppLoader;
}

export class LlamaCppBackend implements DecideBackend {
	readonly name = "llamacpp";
	readonly model: string;
	readonly modelPath: string;
	private readonly contextSize: number;
	private readonly loader: LlamaCppLoader;

	constructor(opts: LlamaCppBackendOptions) {
		if (!opts.modelPath) throw new DecideError("llamacpp backend needs a modelPath");
		if (!opts.model) throw new DecideError("llamacpp backend needs a model label");
		this.modelPath = opts.modelPath;
		this.model = opts.model;
		this.contextSize = opts.contextSize ?? DEFAULT_CONTEXT_SIZE;
		this.loader = opts.loader ?? defaultLlamaCppLoader;
	}

	async ask(request: SystemOneRequest): Promise<SystemOneResponse> {
		validateRequest(request);
		for (const q of request.questions) {
			if (q.kind === "choice" && q.options.length > OLLAMA_MAX_CHOICE_OPTIONS) {
				throw new DecideError(
					`llamacpp backend supports at most ${OLLAMA_MAX_CHOICE_OPTIONS} choice options (got ${q.options.length}); use the laya backend for more`,
				);
			}
		}
		const engine = await getEngine(this.modelPath, this.loader, this.contextSize);
		const run = engine.tail.then(async () => {
			const started = performance.now();
			const answers: Answer[] = [];
			for (const question of request.questions) answers.push(await this.answerOne(engine, request.state, question));
			return { answers, backend: this.name, model: this.model, latencyMs: Math.round(performance.now() - started) };
		});
		engine.tail = run.catch(() => {});
		return run;
	}

	private async answerOne(engine: Engine, state: string, question: Question): Promise<Answer> {
		const labels = labelsFor(question);
		const key = `${question.kind}:${labels.join(",")}`;
		let cands = engine.candidates.get(key);
		if (!cands) {
			cands = candidateTokens(engine.model, question.kind, labels);
			engine.candidates.set(key, cands);
		}
		// Untrusted state text: special-token strings are tokenized as plain text.
		const tokens = engine.model.tokenize(buildPrompt(this.model, state, question), false);
		const bos = engine.model.tokens.bos;
		if (engine.model.tokens.shouldPrependBosToken && bos !== null && tokens[0] !== bos) tokens.unshift(bos);

		let scored = await this.next(engine, tokens, cands);
		const top = scored.slice(0, TOP_TOKENS);
		if (!hasLabelMass(question.kind, labels, top)) {
			// Same one-step rule as the Ollama backend: if the most likely token is
			// pure whitespace (Llama 3 on digits), commit to it and read the next token.
			const lead = top[0];
			if (lead && lead.token.length > 0 && lead.token.trim() === "") {
				scored = await this.next(engine, [...tokens, lead.id], cands);
			}
		}
		return answerFromDistribution(question, distributionFromLogprobs(question.kind, labels, scored));
	}

	/** One forward pass from a clean sequence; logprobs for the candidates plus the top tokens. */
	private async next(engine: Engine, tokens: number[], cands: number[]): Promise<ScoredToken[]> {
		if (tokens.length === 0) throw new DecideError("llamacpp: empty prompt");
		if (tokens.length >= this.contextSize) {
			throw new DecideError(`llamacpp: prompt is ${tokens.length} tokens, context is ${this.contextSize}`);
		}
		// A clean sequence every call: no KV reuse between questions, so output depends on the input only.
		await engine.sequence.clearHistory();
		const last = tokens[tokens.length - 1];
		const res = await engine.sequence.controlledEvaluate([
			...tokens.slice(0, -1),
			[last, { generateNext: { logits: { filter: { tokens: cands, includeTop: TOP_TOKENS } }, totalLogitWeight: true } }],
		]);
		const next = res[res.length - 1]?.next;
		if (!next?.logits || next.logits.size === 0 || !Number.isFinite(next.totalLogitWeight) || (next.totalLogitWeight ?? 0) <= 0) {
			throw new DecideError(`llamacpp returned no logits for model "${this.model}"`);
		}
		return logprobsFromLogits(engine.model, next.logits, next.totalLogitWeight as number);
	}
}
