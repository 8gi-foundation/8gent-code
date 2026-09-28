/**
 * System One tests. Offline: the mock backend plus a fake fetch for the
 * Ollama and laya clients. No network.
 */

import { describe, expect, it } from "bun:test";
import {
	BASH_GUARD_QUESTION,
	DecideError,
	type FetchLike,
	LayaBackend,
	MockBackend,
	OllamaBackend,
	argmax,
	bashGuard,
	buildPrompt,
	createDecider,
	detectBackend,
	distributionFromLogprobs,
	letterLabels,
	mapProbabilities,
	modelPrefix,
	pickModel,
	renormalise,
	resolveOllamaHost,
	scoreLabels,
	validateRequest,
} from "./index";

// ----- helpers -----------------------------------------------------------------

interface Call {
	url: string;
	method: string;
	body: unknown;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Fake fetch routing on URL suffix. A route returning undefined means "connection refused". */
function fakeFetch(routes: Record<string, (body: unknown) => Response | undefined>, calls: Call[] = []): FetchLike {
	return async (url, init) => {
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		calls.push({ url, method: init?.method ?? "GET", body });
		for (const [suffix, handler] of Object.entries(routes)) {
			if (url.endsWith(suffix)) {
				const res = handler(body);
				if (res) return res;
			}
		}
		throw new TypeError(`fetch failed: ${url}`);
	};
}

const lp = (p: number) => Math.log(p);
const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-9);

// ----- contract + math ---------------------------------------------------------

describe("contract", () => {
	it("renormalise divides by the total", () => {
		const d = renormalise([1, 3]);
		close(d[0], 0.25);
		close(d[1], 0.75);
	});

	it("renormalise throws with no mass", () => {
		expect(() => renormalise([0, 0])).toThrow(DecideError);
		expect(() => renormalise([Number.NaN, 1])).toThrow(DecideError);
	});

	it("argmax breaks ties to the lowest index", () => {
		expect(argmax([0.4, 0.4, 0.2])).toBe(0);
		expect(argmax([0.1, 0.2, 0.7])).toBe(2);
	});

	it("validateRequest rejects bad shapes", () => {
		expect(() => validateRequest({ state: "s", questions: [] })).toThrow("non-empty");
		expect(() =>
			validateRequest({ state: "s", questions: [{ id: "a", kind: "choice", prompt: "p", options: ["one"] }] }),
		).toThrow("2..255");
		expect(() =>
			validateRequest({ state: "s", questions: [{ id: "a", kind: "score", prompt: "p", levels: Array(11).fill("x") }] }),
		).toThrow("2..10");
		expect(() =>
			validateRequest({
				state: "s",
				questions: [
					{ id: "a", kind: "noul", prompt: "p" },
					{ id: "a", kind: "noul", prompt: "q" },
				],
			}),
		).toThrow("duplicate");
	});
});

// ----- ollama ------------------------------------------------------------------

describe("ollama backend", () => {
	it("maps letters A.. and caps choice at 26", () => {
		expect(letterLabels(3)).toEqual(["A", "B", "C"]);
		expect(letterLabels(26)[25]).toBe("Z");
		expect(() => letterLabels(27)).toThrow("at most 26");
	});

	it("maps score levels to single digits", () => {
		expect(scoreLabels(2)).toEqual(["1", "2"]);
		expect(scoreLabels(9)[8]).toBe("9");
		expect(scoreLabels(10)).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
	});

	it("sums case and space variants of yes/no and renormalises over the two", () => {
		const top = [
			{ token: " No", logprob: lp(0.3) },
			{ token: " Yes", logprob: lp(0.2) },
			{ token: " yes", logprob: lp(0.2) },
			{ token: "NO", logprob: lp(0.1) },
			{ token: " The", logprob: lp(0.15) },
		];
		const [yes, no] = distributionFromLogprobs("noul", ["yes", "no"], top);
		close(yes, 0.4 / 0.8);
		close(no, 0.4 / 0.8);
	});

	it("reads letter variants but not the lowercase article", () => {
		const top = [
			{ token: " B", logprob: lp(0.5) },
			{ token: " (A", logprob: lp(0.1) },
			{ token: "A.", logprob: lp(0.1) },
			{ token: " a", logprob: lp(0.2) },
		];
		const d = distributionFromLogprobs("choice", ["A", "B", "C"], top);
		close(d[0], 0.2 / 0.7);
		close(d[1], 0.5 / 0.7);
		close(d[2], 0);
	});

	it("throws when no answer token is in the top logprobs", () => {
		expect(() => distributionFromLogprobs("noul", ["yes", "no"], [{ token: " maybe", logprob: -0.1 }])).toThrow(
			"no probability mass",
		);
	});

	it("prompt templates end at the answer slot; qwen3 gets /no_think", () => {
		const noul = buildPrompt("llama3.2:3b", "S", { id: "q", kind: "noul", prompt: "P?" });
		expect(noul.endsWith("Answer (yes or no):")).toBe(true);
		expect(noul.startsWith("/no_think")).toBe(false);
		const choice = buildPrompt("qwen3.8:27b-mlx", "S", { id: "q", kind: "choice", prompt: "P?", options: ["x", "y"] });
		expect(choice.startsWith("/no_think\n")).toBe(true);
		expect(choice).toContain("A. x\nB. y");
		expect(choice.endsWith("Answer with the letter:")).toBe(true);
		const score = buildPrompt("m", "S", { id: "q", kind: "score", prompt: "P?", levels: ["low", "mid", "high"] });
		expect(score).toContain("1. low\n2. mid\n3. high");
		expect(score.endsWith("Answer with the number (1-3):")).toBe(true);
		expect(modelPrefix("Qwen3:8b")).toBe("/no_think\n");
	});

	it("resolves OLLAMA_HOST with or without scheme", () => {
		expect(resolveOllamaHost({})).toBe("http://localhost:11434");
		expect(resolveOllamaHost({ OLLAMA_HOST: "0.0.0.0:11434" })).toBe("http://0.0.0.0:11434");
		expect(resolveOllamaHost({ OLLAMA_HOST: "http://box:1/" })).toBe("http://box:1");
	});

	it("sends pinned deterministic settings and returns the contract shape", async () => {
		const calls: Call[] = [];
		const fetch = fakeFetch(
			{
				"/api/generate": () =>
					json({
						logprobs: [
							{
								top_logprobs: [
									{ token: " Yes", logprob: lp(0.6) },
									{ token: " No", logprob: lp(0.2) },
									{ token: " A", logprob: lp(0.1) },
									{ token: " C", logprob: lp(0.1) },
								],
							},
						],
					}),
			},
			calls,
		);
		const b = new OllamaBackend({ model: "m", host: "http://h", fetch });
		const res = await b.ask({
			state: "S",
			questions: [
				{ id: "n", kind: "noul", prompt: "P?" },
				{ id: "c", kind: "choice", prompt: "P?", options: ["x", "y", "z"] },
			],
		});
		expect(res.backend).toBe("ollama");
		expect(res.model).toBe("m");
		expect(typeof res.latencyMs).toBe("number");
		const [n, c] = res.answers;
		expect(n.kind).toBe("noul");
		if (n.kind !== "noul") throw new Error("kind");
		close(n.probabilities.yes, 0.75);
		close(n.confidence, 0.75);
		if (c.kind !== "choice") throw new Error("kind");
		expect(c.probabilities.length).toBe(3);
		close(c.probabilities[0], 0.5);
		close(c.probabilities[2], 0.5);
		expect(c.chosen).toBe(0);
		expect(calls[0].url).toBe("http://h/api/generate");
		expect(calls[0].body).toMatchObject({
			model: "m",
			stream: false,
			raw: true,
			options: { temperature: 0, num_predict: 1, seed: 1 },
			logprobs: true,
			top_logprobs: 20,
		});
	});

	it("steps past a lone whitespace token to read the digit", async () => {
		const calls: Call[] = [];
		const fetch = fakeFetch(
			{
				"/api/generate": (body) => {
					const prompt = (body as { prompt: string }).prompt;
					const top = prompt.endsWith(": ")
						? [
								{ token: "2", logprob: lp(0.6) },
								{ token: "1", logprob: lp(0.2) },
							]
						: [
								{ token: " ", logprob: lp(0.4) },
								{ token: " __", logprob: lp(0.2) },
							];
					return json({ logprobs: [{ top_logprobs: top }] });
				},
			},
			calls,
		);
		const b = new OllamaBackend({ model: "llama3.2:3b", host: "http://h", fetch });
		const res = await b.ask({ state: "S", questions: [{ id: "s", kind: "score", prompt: "P", levels: ["lo", "mid", "hi"] }] });
		const s = res.answers[0];
		if (s.kind !== "score") throw new Error("kind");
		expect(calls.length).toBe(2);
		expect(s.chosen).toBe(1);
		close(s.probabilities[1], 0.75);
	});

	it("errors clearly when the server returns no logprobs", async () => {
		const fetch = fakeFetch({ "/api/generate": () => json({ response: "Yes" }) });
		const b = new OllamaBackend({ model: "m", host: "http://h", fetch });
		await expect(b.ask({ state: "S", questions: [{ id: "n", kind: "noul", prompt: "P" }] })).rejects.toThrow(
			"no logprobs",
		);
	});
});

// ----- laya --------------------------------------------------------------------

describe("laya backend", () => {
	it("passes the request through and maps answers defensively", async () => {
		const calls: Call[] = [];
		const fetch = fakeFetch(
			{
				"/v1/systemone": () =>
					json({
						model: "laya-small",
						answers: [
							{ id: "c", probabilities: [2, 6, 2] },
							{ id: "n", probabilities: { yes: 0.9 } },
						],
					}),
			},
			calls,
		);
		const b = new LayaBackend({ url: "http://l", fetch });
		const req = {
			state: "S",
			questions: [
				{ id: "n", kind: "noul" as const, prompt: "P" },
				{ id: "c", kind: "choice" as const, prompt: "P", options: ["x", "y", "z"] },
			],
		};
		const res = await b.ask(req);
		expect(calls[0].body).toEqual(req);
		expect(res.model).toBe("laya-small");
		expect(res.answers.map((a) => a.id)).toEqual(["n", "c"]);
		const c = res.answers[1];
		if (c.kind !== "choice") throw new Error("kind");
		close(c.probabilities[1], 0.6);
		expect(c.chosen).toBe(1);
	});

	it("accepts several noul shapes and rejects missing ones", () => {
		const q = { id: "n", kind: "noul" as const, prompt: "P" };
		close(mapProbabilities(q, 0.3)[0], 0.3);
		close(mapProbabilities(q, { no: 0.3 })[0], 0.7);
		close(mapProbabilities(q, [1, 3])[0], 0.25);
		expect(() => mapProbabilities(q, { maybe: 1 })).toThrow("no usable");
		const c = { id: "c", kind: "choice" as const, prompt: "P", options: ["x", "y"] };
		expect(() => mapProbabilities(c, [1, 2, 3])).toThrow("3 probabilities for 2");
		close(mapProbabilities(c, { y: 1 })[1], 1);
	});

	it("reports unreachable servers as unavailable", async () => {
		const b = new LayaBackend({ url: "http://l", fetch: fakeFetch({}) });
		await expect(b.ask({ state: "S", questions: [{ id: "n", kind: "noul", prompt: "P" }] })).rejects.toThrow(
			"laya unreachable",
		);
	});
});

// ----- mock --------------------------------------------------------------------

describe("mock backend", () => {
	it("is deterministic and follows word overlap", async () => {
		const m = new MockBackend();
		const req = {
			state: "the database migration failed",
			questions: [
				{ id: "n", kind: "noul" as const, prompt: "Did the database migration fail?" },
				{ id: "c", kind: "choice" as const, prompt: "Which area?", options: ["frontend styling", "database migration"] },
				{ id: "s", kind: "score" as const, prompt: "How bad?", levels: ["nothing", "migration failed", "total outage"] },
			],
		};
		const a = await m.ask(req);
		const b = await m.ask(req);
		expect(a).toEqual(b);
		const [n, c, s] = a.answers;
		if (n.kind !== "noul" || c.kind !== "choice" || s.kind !== "score") throw new Error("kind");
		expect(n.probabilities.yes).toBeGreaterThan(0.5);
		expect(c.chosen).toBe(1);
		expect(s.chosen).toBe(1);
		const sum = s.probabilities.reduce((x, y) => x + y, 0);
		close(sum, 1);
	});
});

// ----- probe -------------------------------------------------------------------

describe("probe", () => {
	const tags = {
		models: [
			{ name: "nomic-embed-text:latest", size: 1 },
			{ name: "qwen3.8:27b-mlx", size: 18_000 },
			{ name: "llama3.2:3b", size: 2_000 },
			{ name: "hf.co/openbmb/MiniCPM5-1B-GGUF:Q8_0", size: 1_100 },
		],
	};

	it("prefers laya when its health check answers", async () => {
		const fetch = fakeFetch({ "/health": () => json({ ok: true }), "/api/tags": () => json(tags) });
		const r = await detectBackend({ fetch, env: {} });
		expect(r.backend).toBe("laya");
		expect(r.url).toBe("http://127.0.0.1:8000");
		expect(r.os).toBe(process.platform);
		expect(r.arch).toBe(process.arch);
	});

	it("falls back to ollama and picks from the installed list", async () => {
		const fetch = fakeFetch({ "/api/tags": () => json(tags) });
		const r = await detectBackend({ fetch, env: {} });
		expect(r.backend).toBe("ollama");
		expect(r.model).toBe("llama3.2:3b");
		expect(r.notes[0]).toContain("laya unreachable");
	});

	it("honours EIGHT_DECIDE_MODEL only when installed", async () => {
		const fetch = fakeFetch({ "/api/tags": () => json(tags) });
		expect((await detectBackend({ fetch, env: { EIGHT_DECIDE_MODEL: "qwen3.8:27b-mlx" } })).model).toBe("qwen3.8:27b-mlx");
		expect((await detectBackend({ fetch, env: { EIGHT_DECIDE_MODEL: "not-installed" } })).model).toBe("llama3.2:3b");
	});

	it("reports none when nothing answers", async () => {
		const r = await detectBackend({ fetch: fakeFetch({}), env: {} });
		expect(r.backend).toBe("none");
		expect(r.model).toBeNull();
		expect(r.notes.length).toBe(2);
	});

	it("pickModel never invents a model and skips embeddings", () => {
		expect(pickModel([])).toBeNull();
		expect(pickModel([{ name: "nomic-embed-text" }])).toBeNull();
		expect(pickModel([{ name: "somethingelse:1b", size: 5 }, { name: "other:7b", size: 9 }])).toBe("somethingelse:1b");
	});
});

// ----- decider -----------------------------------------------------------------

describe("createDecider", () => {
	it("helpers return typed answers with backend metadata", async () => {
		const d = createDecider({ backend: "mock" });
		const n = await d.noul("tests pass", "Do the tests pass?");
		expect(n.kind).toBe("noul");
		expect(n.backend).toBe("mock");
		const c = await d.choice("ship it", "Next?", ["ship it", "wait"]);
		expect(c.chosen).toBe(0);
		const s = await d.score("mostly done", "Progress?", ["not started", "mostly done", "finished"]);
		expect(s.chosen).toBe(1);
	});

	it("auto selects ollama through the probe", async () => {
		const fetch = fakeFetch({
			"/api/tags": () => json({ models: [{ name: "llama3.2:3b", size: 1 }] }),
			"/api/generate": () => json({ logprobs: [{ top_logprobs: [{ token: " no", logprob: lp(0.9) }, { token: " yes", logprob: lp(0.1) }] }] }),
		});
		const d = createDecider({ fetch, env: {} });
		const n = await d.noul("S", "P?");
		expect(n.backend).toBe("ollama");
		expect(n.model).toBe("llama3.2:3b");
		close(n.probabilities.yes, 0.1);
	});

	it("memoises so a jittery backend still gives same input -> same output", async () => {
		let n = 0;
		const jitter = {
			name: "jitter",
			model: "j",
			ask: async (req: { questions: Array<{ id: string }> }) => ({
				answers: [{ id: req.questions[0].id, kind: "noul" as const, probabilities: { yes: 0.3 + ++n * 1e-5 }, confidence: 0.7 }],
				backend: "jitter",
				model: "j",
				latencyMs: 1,
			}),
		};
		const d = createDecider({ backend: jitter });
		const a = await d.noul("S", "P?");
		const b = await d.noul("S", "P?");
		expect(a).toEqual(b);
		expect(n).toBe(1);
		const off = createDecider({ backend: jitter, cacheSize: 0 });
		const c = await off.noul("S", "P?");
		const e = await off.noul("S", "P?");
		expect(c.probabilities.yes).not.toBe(e.probabilities.yes);
	});

	it("rejects with unavailable when nothing is reachable", async () => {
		const d = createDecider({ fetch: fakeFetch({}), env: {} });
		await expect(d.noul("S", "P?")).rejects.toThrow("no decide backend available");
	});
});

// ----- guard -------------------------------------------------------------------

describe("bashGuard", () => {
	const fixed = (yes: number) => ({
		noul: async () => ({ id: "q", kind: "noul" as const, probabilities: { yes }, confidence: 0, backend: "t", model: "t", latencyMs: 0 }),
	});

	it("applies thresholds in code", async () => {
		expect((await bashGuard("x", fixed(0.9))).verdict).toBe("block");
		expect((await bashGuard("x", fixed(0.1))).verdict).toBe("allow");
		expect((await bashGuard("x", fixed(0.5))).verdict).toBe("escalate");
		expect((await bashGuard("x", fixed(0.35))).verdict).toBe("escalate");
		expect((await bashGuard("x", fixed(0.3), { blockAbove: 0.2, escalateBand: [0.9, 0.95] })).verdict).toBe("block");
	});

	it("fails closed when the decider throws", async () => {
		const r = await bashGuard("x", {
			noul: async () => {
				throw new Error("boom");
			},
		});
		expect(r.verdict).toBe("block");
		expect(Number.isNaN(r.pYes)).toBe(true);
		expect(r.reason).toContain("failing closed");
	});

	it("fails closed on an invalid probability", async () => {
		expect((await bashGuard("x", fixed(Number.NaN))).verdict).toBe("block");
		expect((await bashGuard("x", fixed(1.5))).verdict).toBe("block");
	});

	it("fails closed when no backend is reachable", async () => {
		const r = await bashGuard("ls", createDecider({ fetch: fakeFetch({}), env: {} }));
		expect(r.verdict).toBe("block");
	});

	it("asks the fixed guard question with the command as state", async () => {
		const seen: string[] = [];
		await bashGuard("ls -la", {
			noul: async (state, prompt) => {
				seen.push(state, prompt);
				return { id: "q", kind: "noul", probabilities: { yes: 0 }, confidence: 1, backend: "t", model: "t", latencyMs: 0 };
			},
		});
		expect(seen).toEqual(["Shell command:\nls -la", BASH_GUARD_QUESTION]);
	});
});
