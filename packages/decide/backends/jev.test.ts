/**
 * Jev backend tests. Offline: a fake fetch stands in for the Vercel AI
 * Gateway. No network, no key. The request shape asserted here is the one
 * the gateway's validator accepted on 2026-10-07 (questions as a record,
 * type boolean | choice | score, state required).
 */

import { describe, expect, it } from "bun:test";
import {
	DECIDE_BACKEND_ENV,
	DecideError,
	DecideUnavailableError,
	FallbackBackend,
	type FallbackLog,
	type FetchLike,
	JEV_KEY_ENV,
	JEV_URL,
	JevBackend,
	MockBackend,
	choiceKeys,
	createDecider,
	fromJevAnswer,
	resolveJevKey,
	toJevBody,
} from "../index";

interface Call {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** Fake gateway: one handler for every POST. `undefined` means connection refused. */
function fakeGateway(
	handler: (body: Record<string, unknown>) => Response | undefined,
	calls: Call[] = [],
): FetchLike {
	return async (url, init) => {
		const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
		calls.push({ url, headers: (init?.headers as Record<string, string>) ?? {}, body });
		const res = handler(body);
		if (!res) throw new TypeError(`fetch failed: ${url}`);
		return res;
	};
}

const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-9);
const noul = { id: "n", kind: "noul" as const, prompt: "Is it urgent?" };
const choice = {
	id: "c",
	kind: "choice" as const,
	prompt: "Which team?",
	options: ["billing", "account", "other"],
};
const score = {
	id: "s",
	kind: "score" as const,
	prompt: "How severe?",
	levels: ["cosmetic", "degraded", "blocking"],
};

describe("jev request shape", () => {
	it("maps the three kinds to the gateway's record shape", () => {
		const body = toJevBody({ state: "S", questions: [noul, choice, score] });
		expect(body.model).toBe("typesafe-ai/jev");
		expect(body.state).toBe("S");
		expect(Array.isArray(body.questions)).toBe(false);
		expect(body.questions.n).toEqual({ type: "boolean", instructions: "Is it urgent?" });
		expect(body.questions.c).toEqual({
			type: "choice",
			instructions: "Which team?",
			criteria: { billing: "billing", account: "account", other: "other" },
		});
		expect(body.questions.s).toEqual({
			type: "score",
			instructions: "How severe?",
			criteria: ["cosmetic", "degraded", "blocking"],
		});
		expect(body.providerOptions.gateway.zeroDataRetention).toBe(true);
	});

	it("keeps choice keys unique and stable when options repeat", () => {
		expect(choiceKeys(["a", "b", "a"])).toEqual(["a (0)", "b", "a (2)"]);
		expect(choiceKeys(["x", "y"])).toEqual(["x", "y"]);
	});

	it("reads the key from AI_GATEWAY_API_KEY only", () => {
		expect(resolveJevKey({ [JEV_KEY_ENV]: " k1 " })).toBe("k1");
		expect(resolveJevKey({ [JEV_KEY_ENV]: "" })).toBeNull();
		expect(resolveJevKey({ OPENROUTER_API_KEY: "nope" })).toBeNull();
		expect(() => new JevBackend({ apiKey: "" })).toThrow(DecideUnavailableError);
	});
});

describe("jev answer mapping", () => {
	it("boolean: probability, noul, boolean or the map; rejects nothing usable", () => {
		close(fromJevAnswer(noul, { type: "boolean", probability: 0.98 })[0], 0.98);
		close(fromJevAnswer(noul, { type: "noul", noul: 0.2 })[0], 0.2);
		close(fromJevAnswer(noul, { boolean: 0.4 })[0], 0.4);
		close(fromJevAnswer(noul, { probabilities: { true: 0.7, false: 0.3 } })[0], 0.7);
		close(fromJevAnswer(noul, { probabilities: { false: 0.3 } })[0], 0.7);
		expect(() => fromJevAnswer(noul, { type: "boolean" })).toThrow("no usable probability");
		expect(() => fromJevAnswer(noul, { probability: 1.5 })).toThrow("no usable probability");
	});

	it("choice: probabilities keyed by option, in option order, renormalised", () => {
		const d = fromJevAnswer(choice, {
			type: "choice",
			choice: "account",
			probabilities: { other: 0.2, account: 0.6, billing: 0.2 },
		});
		expect(d).toEqual([0.2, 0.6, 0.2]);
		const oneHot = fromJevAnswer(choice, { type: "choice", choice: "other" });
		expect(oneHot).toEqual([0, 0, 1]);
		expect(() => fromJevAnswer(choice, { type: "choice" })).toThrow("no probabilities");
	});

	it("score: probabilities keyed by level index", () => {
		const d = fromJevAnswer(score, {
			type: "score",
			score: 1.43,
			probabilities: { "0": 0, "1": 0.57, "2": 0.43 },
		});
		close(d[1], 0.57);
		close(d[2], 0.43);
	});
});

describe("jev backend", () => {
	it("posts to the gateway with the bearer key and maps a full answer set", async () => {
		const calls: Call[] = [];
		const fetch = fakeGateway(
			() =>
				json({
					model: "jev-1.13.0",
					answers: {
						n: { type: "boolean", probability: 0.9 },
						c: {
							type: "choice",
							choice: "billing",
							probabilities: { billing: 0.8, account: 0.1, other: 0.1 },
						},
						s: { type: "score", score: 2, probabilities: { "0": 0, "1": 0, "2": 1 } },
					},
				}),
			calls,
		);
		const b = new JevBackend({ apiKey: "secret-k", fetch });
		const res = await b.ask({ state: "S", questions: [noul, choice, score] });
		expect(calls[0].url).toBe(JEV_URL);
		expect(calls[0].headers.authorization).toBe("Bearer secret-k");
		expect(res.backend).toBe("jev");
		expect(res.model).toBe("jev-1.13.0");
		const [n, c, s] = res.answers;
		if (n.kind !== "noul" || c.kind !== "choice" || s.kind !== "score") throw new Error("kinds");
		close(n.probabilities.yes, 0.9);
		expect(c.chosen).toBe(0);
		close(c.confidence, 0.8);
		expect(s.chosen).toBe(2);
	});

	it("a refused tier (403) is unavailable, with the gateway's message and no state echoed", async () => {
		const fetch = fakeGateway(() =>
			json(
				{
					error: {
						message: "Free tier users do not have access to this model. Upgrade to paid credits.",
						type: "no_providers_available",
					},
				},
				403,
			),
		);
		const b = new JevBackend({ apiKey: "k", fetch });
		const err = await b.ask({ state: "SECRET-STATE", questions: [noul] }).catch((e: Error) => e);
		expect(err).toBeInstanceOf(DecideUnavailableError);
		expect((err as Error).message).toContain("403");
		expect((err as Error).message).toContain("Free tier");
		expect((err as Error).message).not.toContain("SECRET-STATE");
	});

	it("connection refused and timeouts are unavailable; a missing answer is a plain DecideError", async () => {
		const down = new JevBackend({ apiKey: "k", fetch: fakeGateway(() => undefined) });
		await expect(down.ask({ state: "S", questions: [noul] })).rejects.toThrow(
			DecideUnavailableError,
		);
		const slow: FetchLike = (_url, init) =>
			new Promise((_, reject) => {
				init?.signal?.addEventListener("abort", () =>
					reject(new Error("The operation timed out.")),
				);
			});
		const t = new JevBackend({ apiKey: "k", fetch: slow, timeoutMs: 5 });
		await expect(t.ask({ state: "S", questions: [noul] })).rejects.toThrow(DecideUnavailableError);
		const partial = new JevBackend({
			apiKey: "k",
			fetch: fakeGateway(() => json({ answers: {} })),
		});
		const err = await partial.ask({ state: "S", questions: [noul] }).catch((e: Error) => e);
		expect(err).toBeInstanceOf(DecideError);
		expect(err).not.toBeInstanceOf(DecideUnavailableError);
	});
});

describe("fallback", () => {
	it("answers from the primary and logs it", async () => {
		const logs: FallbackLog[] = [];
		const jev = new JevBackend({
			apiKey: "k",
			fetch: fakeGateway(() => json({ model: "jev-1", answers: { n: { probability: 0.75 } } })),
		});
		let built = 0;
		const fb = new FallbackBackend(
			jev,
			async () => {
				built++;
				return new MockBackend();
			},
			(e) => logs.push(e),
		);
		const res = await fb.ask({ state: "S", questions: [noul] });
		expect(res.backend).toBe("jev");
		expect(built).toBe(0);
		expect(logs).toEqual([{ backend: "jev", model: "jev-1", latencyMs: res.latencyMs }]);
	});

	it("any primary error sends the same request to the fallback, built once, and logs why", async () => {
		const logs: FallbackLog[] = [];
		const jev = new JevBackend({
			apiKey: "k",
			fetch: fakeGateway(() => json({ error: { message: "Free tier users" } }, 403)),
		});
		let built = 0;
		const fb = new FallbackBackend(
			jev,
			async () => {
				built++;
				return new MockBackend();
			},
			(e) => logs.push(e),
		);
		const a = await fb.ask({ state: "S", questions: [noul] });
		const b = await fb.ask({ state: "S", questions: [choice] });
		expect(a.backend).toBe("mock");
		expect(b.backend).toBe("mock");
		expect(built).toBe(1);
		expect(logs).toHaveLength(2);
		expect(logs[0].fellBackFrom?.backend).toBe("jev");
		expect(logs[0].fellBackFrom?.reason).toContain("403");
	});
});

describe("createDecider with EIGHT_DECIDE_BACKEND=jev", () => {
	const localFetch: FetchLike = async (url) => {
		// The local probe: no shared judge, no laya, Ollama serves one small model.
		if (url.endsWith("/api/tags")) return json({ models: [{ name: "llama3.2:3b", size: 1 }] });
		if (url.endsWith("/api/generate"))
			return json({
				logprobs: [
					{
						top_logprobs: [
							{ token: "yes", logprob: Math.log(0.6) },
							{ token: "no", logprob: Math.log(0.4) },
						],
					},
				],
			});
		throw new TypeError(`fetch failed: ${url}`);
	};

	it("without the env the default path is untouched and nothing goes to the gateway", async () => {
		const calls: Call[] = [];
		const fetch: FetchLike = (url, init) =>
			url === JEV_URL ? fakeGateway(() => json({}), calls)(url, init) : localFetch(url, init);
		const d = createDecider({
			fetch,
			env: { [JEV_KEY_ENV]: "k", EIGHT_S1_SHARED_JUDGE: "0" },
			llamacppLoader: null,
			log: () => {},
		});
		const a = await d.noul("S", "Q");
		expect(a.backend).toBe("ollama");
		expect(calls).toHaveLength(0);
	});

	it("with the env and a key, Jev answers first and the local judge takes any error", async () => {
		const logs: FallbackLog[] = [];
		let gateway = (): Response => json({ model: "jev-1", answers: { q: { probability: 0.9 } } });
		const fetch: FetchLike = (url, init) =>
			url === JEV_URL ? fakeGateway(() => gateway())(url, init) : localFetch(url, init);
		const env = { [JEV_KEY_ENV]: "k", [DECIDE_BACKEND_ENV]: "jev", EIGHT_S1_SHARED_JUDGE: "0" };
		const d = createDecider({
			fetch,
			env,
			llamacppLoader: null,
			log: (e) => logs.push(e),
			cacheSize: 0,
		});
		const a = await d.noul("S", "Q1");
		expect(a.backend).toBe("jev");
		close(a.probabilities.yes, 0.9);
		gateway = () =>
			json({ error: { message: "Free tier users do not have access to this model." } }, 403);
		const b = await d.noul("S", "Q2");
		expect(b.backend).toBe("ollama");
		expect(b.model).toBe("llama3.2:3b");
		close(b.probabilities.yes, 0.6);
		expect(logs.map((l) => l.backend)).toEqual(["jev", "ollama"]);
		expect(logs[1].fellBackFrom?.reason).toContain("Free tier");
	});

	it("with the env but no key, the local judge answers and the swap is logged once", async () => {
		const logs: FallbackLog[] = [];
		const d = createDecider({
			fetch: localFetch,
			env: { [DECIDE_BACKEND_ENV]: "jev", EIGHT_S1_SHARED_JUDGE: "0" },
			llamacppLoader: null,
			log: (e) => logs.push(e),
		});
		const a = await d.noul("S", "Q");
		expect(a.backend).toBe("ollama");
		expect(logs).toHaveLength(1);
		expect(logs[0].fellBackFrom?.reason).toContain(JEV_KEY_ENV);
	});

	it("backend: 'jev' is the bare hosted backend with no fallback", async () => {
		const fetch = fakeGateway(() => json({ error: { message: "Free tier users" } }, 403));
		const d = createDecider({ backend: "jev", fetch, env: { [JEV_KEY_ENV]: "k" } });
		await expect(d.noul("S", "Q")).rejects.toThrow(DecideUnavailableError);
	});
});
