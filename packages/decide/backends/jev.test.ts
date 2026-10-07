/**
 * Jev backend tests. Offline: a fake fetch stands in for the Vercel AI
 * Gateway. No network, no real key. The request shape asserted here is the
 * one the gateway's validator accepted on 2026-10-07 (questions as a
 * record, type boolean | choice | score, state required).
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
	PILOT_LOCK_RELATIVE,
	choiceKeys,
	createDecider,
	fromJevAnswer,
	jevForbidden,
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

/** A fetch that never settles until its signal aborts (the gateway hanging). */
const hanging: FetchLike = (_url, init) =>
	new Promise((_, reject) => {
		init?.signal?.addEventListener("abort", () => reject(new Error("The operation timed out.")));
	});

const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-9);
const KEY = "vck_SECRET_KEY_0123456789";
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

/** A 403 whose body carries the request state AND the key, so an echo would be caught. */
const refusedEchoing = (body: Record<string, unknown>) =>
	json(
		{
			error: {
				message: `Free tier users do not have access to this model. state=${String(body.state)} key=${KEY}`,
				type: "no_providers_available",
				param: { state: body.state, authorization: `Bearer ${KEY}` },
			},
		},
		403,
	);

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
		expect(fromJevAnswer(choice, { type: "choice", choice: "other" })).toEqual([0, 0, 1]);
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
		const b = new JevBackend({ apiKey: KEY, fetch });
		const res = await b.ask({ state: "S", questions: [noul, choice, score] });
		expect(calls[0].url).toBe(JEV_URL);
		expect(calls[0].headers.authorization).toBe(`Bearer ${KEY}`);
		expect(res.backend).toBe("jev");
		expect(res.model).toBe("jev-1.13.0");
		const [n, c, s] = res.answers;
		if (n.kind !== "noul" || c.kind !== "choice" || s.kind !== "score") throw new Error("kinds");
		close(n.probabilities.yes, 0.9);
		expect(c.chosen).toBe(0);
		close(c.confidence, 0.8);
		expect(s.chosen).toBe(2);
	});

	it("a refused tier (403) is unavailable: status plus the fixed error code, never the body's state, key or free text", async () => {
		const b = new JevBackend({ apiKey: KEY, fetch: fakeGateway(refusedEchoing) });
		const err = await b.ask({ state: "SECRET-STATE", questions: [noul] }).catch((e: Error) => e);
		expect(err).toBeInstanceOf(DecideUnavailableError);
		expect((err as Error).message).toBe("jev /v1/evaluate 403 no_providers_available");
		expect((err as Error).message).not.toContain("SECRET-STATE");
		expect((err as Error).message).not.toContain(KEY);
		expect((err as Error).message).not.toContain("Free tier");
		// A body with no parsable code, or one that is not a plain token, is reported as unknown.
		const odd = new JevBackend({
			apiKey: KEY,
			fetch: fakeGateway(() => new Response(`SECRET-STATE ${KEY}`, { status: 500 })),
		});
		const e2 = await odd.ask({ state: "SECRET-STATE", questions: [noul] }).catch((e: Error) => e);
		expect((e2 as Error).message).toBe("jev /v1/evaluate 500 unknown");
		const inj = new JevBackend({
			apiKey: KEY,
			fetch: fakeGateway(() => json({ error: { type: `leak ${KEY}` } }, 502)),
		});
		const e3 = await inj.ask({ state: "S", questions: [noul] }).catch((e: Error) => e);
		expect((e3 as Error).message).toBe("jev /v1/evaluate 502 unknown");
	});

	it("connection refused and timeouts are unavailable; a missing answer is a plain DecideError", async () => {
		const down = new JevBackend({ apiKey: KEY, fetch: fakeGateway(() => undefined) });
		await expect(down.ask({ state: "S", questions: [noul] })).rejects.toThrow(
			DecideUnavailableError,
		);
		const t = new JevBackend({ apiKey: KEY, fetch: hanging, timeoutMs: 5 });
		await expect(t.ask({ state: "S", questions: [noul] })).rejects.toThrow(DecideUnavailableError);
		const partial = new JevBackend({
			apiKey: KEY,
			fetch: fakeGateway(() => json({ answers: {} })),
		});
		const err = await partial.ask({ state: "S", questions: [noul] }).catch((e: Error) => e);
		expect(err).toBeInstanceOf(DecideError);
		expect(err).not.toBeInstanceOf(DecideUnavailableError);
	});

	it("the key never appears in any thrown message", async () => {
		const fetches: Array<[string, FetchLike]> = [
			["403 echoing", fakeGateway(refusedEchoing)],
			["500 raw", fakeGateway(() => new Response(`key=${KEY}`, { status: 500 }))],
			["refused", fakeGateway(() => undefined)],
			["throws with key", () => Promise.reject(new Error(`boom ${KEY}`))],
			["hangs", hanging],
			["no answers", fakeGateway(() => json({ answers: {}, note: KEY }))],
		];
		for (const [label, fetch] of fetches) {
			const b = new JevBackend({ apiKey: KEY, fetch, timeoutMs: 5 });
			const err = await b.ask({ state: "S", questions: [noul] }).catch((e: Error) => e);
			expect(err, label).toBeInstanceOf(Error);
			expect((err as Error).message, label).not.toContain(KEY);
		}
	});
});

describe("jevForbidden", () => {
	it("refuses under SIGI_RUN or PILOT_RUN, allows otherwise", () => {
		const never = () => false;
		expect(jevForbidden({ HOME: "/nonexistent" }, never)).toBeNull();
		expect(jevForbidden({ HOME: "/nonexistent", SIGI_RUN: "1" }, never)).toContain("SIGI_RUN");
		expect(jevForbidden({ HOME: "/nonexistent", PILOT_RUN: "baseline" }, never)).toContain(
			"PILOT_RUN",
		);
		expect(jevForbidden({ HOME: "/nonexistent", SIGI_RUN: "  " }, never)).toBeNull();
	});

	it("refuses while the pilot lock exists under HOME", () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "jev-home-"));
		try {
			expect(jevForbidden({ HOME: home })).toBeNull();
			const lock = path.join(home, PILOT_LOCK_RELATIVE);
			fs.mkdirSync(path.dirname(lock), { recursive: true });
			fs.writeFileSync(lock, "{}");
			expect(jevForbidden({ HOME: home })).toContain("pilot lock present");
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("fallback", () => {
	const mockBuilder = () => {
		let built = 0;
		return {
			build: async () => {
				built++;
				return new MockBackend();
			},
			count: () => built,
		};
	};

	it("answers from the primary and logs it", async () => {
		const logs: FallbackLog[] = [];
		const jev = new JevBackend({
			apiKey: KEY,
			fetch: fakeGateway(() => json({ model: "jev-1", answers: { n: { probability: 0.75 } } })),
		});
		const mb = mockBuilder();
		const fb = new FallbackBackend(jev, mb.build, (e) => logs.push(e));
		const res = await fb.ask({ state: "S", questions: [noul] });
		expect(res.backend).toBe("jev");
		expect(mb.count()).toBe(0);
		expect(logs).toEqual([{ backend: "jev", model: "jev-1", latencyMs: res.latencyMs }]);
	});

	it("any primary error sends the same request to the fallback, built once, and logs status plus code", async () => {
		const logs: FallbackLog[] = [];
		const jev = new JevBackend({ apiKey: KEY, fetch: fakeGateway(refusedEchoing) });
		const mb = mockBuilder();
		const fb = new FallbackBackend(jev, mb.build, (e) => logs.push(e));
		const a = await fb.ask({ state: "SECRET-STATE", questions: [noul] });
		const b = await fb.ask({ state: "SECRET-STATE", questions: [choice] });
		expect(a.backend).toBe("mock");
		expect(b.backend).toBe("mock");
		expect(mb.count()).toBe(1);
		expect(logs).toHaveLength(2);
		expect(logs[0].fellBackFrom).toEqual({
			backend: "jev",
			reason: "jev /v1/evaluate 403 no_providers_available",
		});
	});

	it("a primary that times out falls back to local, both when it honours its signal and when it hangs", async () => {
		const logs: FallbackLog[] = [];
		const honours = new JevBackend({ apiKey: KEY, fetch: hanging, timeoutMs: 5 });
		const fb1 = new FallbackBackend(honours, mockBuilder().build, (e) => logs.push(e));
		const r1 = await fb1.ask({ state: "S", questions: [noul] });
		expect(r1.backend).toBe("mock");
		expect(logs[0].fellBackFrom?.backend).toBe("jev");
		// A primary that ignores its own timeout: the FallbackBackend's own timer fires.
		const stuck = { name: "stuck", model: "m", ask: () => new Promise<never>(() => {}) };
		const fb2 = new FallbackBackend(stuck, mockBuilder().build, (e) => logs.push(e), 10);
		const r2 = await fb2.ask({ state: "S", questions: [noul] });
		expect(r2.backend).toBe("mock");
		expect(logs[1].fellBackFrom).toEqual({
			backend: "stuck",
			reason: "stuck timed out after 10 ms",
		});
	});

	it("the key never appears in any FallbackLog reason", async () => {
		const logs: FallbackLog[] = [];
		const fetches: FetchLike[] = [
			fakeGateway(refusedEchoing),
			fakeGateway(() => new Response(`key=${KEY}`, { status: 500 })),
			fakeGateway(() => undefined),
			() => Promise.reject(new Error(`boom ${KEY}`)),
			hanging,
			fakeGateway(() => json({ answers: {} })),
		];
		for (const fetch of fetches) {
			const fb = new FallbackBackend(
				new JevBackend({ apiKey: KEY, fetch, timeoutMs: 5 }),
				mockBuilder().build,
				(e) => logs.push(e),
			);
			await fb.ask({ state: "S", questions: [noul] });
		}
		expect(logs).toHaveLength(fetches.length);
		for (const l of logs) {
			expect(l.fellBackFrom).toBeDefined();
			expect(l.fellBackFrom?.reason).not.toContain(KEY);
			expect(JSON.stringify(l)).not.toContain(KEY);
		}
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
	const base = { HOME: "/nonexistent", EIGHT_S1_SHARED_JUDGE: "0" };

	it("without the env the default path is untouched and nothing goes to the gateway", async () => {
		const calls: Call[] = [];
		const fetch: FetchLike = (url, init) =>
			url === JEV_URL ? fakeGateway(() => json({}), calls)(url, init) : localFetch(url, init);
		const d = createDecider({
			fetch,
			env: { ...base, [JEV_KEY_ENV]: KEY },
			llamacppLoader: null,
			log: () => {},
		});
		const a = await d.noul("S", "Q");
		expect(a.backend).toBe("ollama");
		expect(calls).toHaveLength(0);
	});

	it("with the env and a key, Jev answers first and the local judge takes any error", async () => {
		const logs: FallbackLog[] = [];
		let gateway = (b: Record<string, unknown>): Response =>
			json({ model: "jev-1", answers: { q: { probability: 0.9 } } });
		const fetch: FetchLike = (url, init) =>
			url === JEV_URL ? fakeGateway((b) => gateway(b))(url, init) : localFetch(url, init);
		const env = { ...base, [JEV_KEY_ENV]: KEY, [DECIDE_BACKEND_ENV]: "jev" };
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
		gateway = refusedEchoing;
		const b = await d.noul("S", "Q2");
		expect(b.backend).toBe("ollama");
		expect(b.model).toBe("llama3.2:3b");
		close(b.probabilities.yes, 0.6);
		expect(logs.map((l) => l.backend)).toEqual(["jev", "ollama"]);
		expect(logs[1].fellBackFrom?.reason).toBe("jev /v1/evaluate 403 no_providers_available");
	});

	it("with the env but no key, the local judge answers and the swap is logged once", async () => {
		const logs: FallbackLog[] = [];
		const d = createDecider({
			fetch: localFetch,
			env: { ...base, [DECIDE_BACKEND_ENV]: "jev" },
			llamacppLoader: null,
			log: (e) => logs.push(e),
		});
		const a = await d.noul("S", "Q");
		expect(a.backend).toBe("ollama");
		expect(logs).toHaveLength(1);
		expect(logs[0].fellBackFrom?.reason).toContain(JEV_KEY_ENV);
	});

	it("under SIGI_RUN or PILOT_RUN the hosted judge is refused: auto goes local and logs it, bare jev throws, nothing reaches the gateway", async () => {
		for (const flag of ["SIGI_RUN", "PILOT_RUN"]) {
			const calls: Call[] = [];
			const logs: FallbackLog[] = [];
			const fetch: FetchLike = (url, init) =>
				url === JEV_URL
					? fakeGateway(() => json({ answers: { q: { probability: 0.9 } } }), calls)(url, init)
					: localFetch(url, init);
			const env = { ...base, [JEV_KEY_ENV]: KEY, [DECIDE_BACKEND_ENV]: "jev", [flag]: "1" };
			const d = createDecider({ fetch, env, llamacppLoader: null, log: (e) => logs.push(e) });
			const a = await d.noul("S", "Q");
			expect(a.backend).toBe("ollama");
			expect(calls).toHaveLength(0);
			expect(logs).toHaveLength(1);
			expect(logs[0].fellBackFrom?.reason).toContain(flag);
			const bare = createDecider({ backend: "jev", fetch, env });
			await expect(bare.noul("S", "Q")).rejects.toThrow(`jev refused: ${flag}`);
			expect(calls).toHaveLength(0);
		}
	});

	it("backend: 'jev' is the bare hosted backend with no fallback", async () => {
		const fetch = fakeGateway(refusedEchoing);
		const d = createDecider({ backend: "jev", fetch, env: { ...base, [JEV_KEY_ENV]: KEY } });
		await expect(d.noul("S", "Q")).rejects.toThrow(DecideUnavailableError);
	});
});
