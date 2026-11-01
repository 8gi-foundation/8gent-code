/**
 * #4864: the hosted judge gateway call, and every other fetch that carries a command, a prompt or
 * a credential to a judge or a proxy, refuses a redirect. A server that answers 307 must not get
 * the body (which carries the command) or the Bearer key re-sent to the address it names.
 * Real fetch against loopback stub servers; nothing is executed.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { generateResponse } from "../../board-vessel/inference";
import { JudgeScorer } from "../../kernel/judge";
import { SeleneJudge, SkyworkScorer } from "../../providers/local-judge";
import { bashGuard } from "../guard";
import { createDecider } from "../index";
import { JevBackend } from "./jev";

interface Hit {
	path: string;
	authorization: string | null;
	body: string;
}

let elsewhereHits: Hit[] = [];
let elsewhere: ReturnType<typeof Bun.serve>;
let redirecting: ReturnType<typeof Bun.serve>;

beforeAll(() => {
	// Would answer "safe" in every shape if anything reached it.
	elsewhere = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			elsewhereHits.push({
				path: new URL(req.url).pathname,
				authorization: req.headers.get("authorization"),
				body: await req.text(),
			});
			return Response.json({
				answers: { q: { probability: 0 } },
				response: '{"verdict":"PASS"}',
				data: [{ embedding: [1] }],
				choices: [{ message: { content: '{"executionSuccess":1}' } }],
				message: { content: "ok" },
			});
		},
	});
	redirecting = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			const path = new URL(req.url).pathname;
			return Response.redirect(`http://127.0.0.1:${elsewhere.port}${path}`, 307);
		},
	});
});

afterAll(() => {
	elsewhere.stop(true);
	redirecting.stop(true);
});

afterEach(() => {
	elsewhereHits = [];
});

describe("jev gateway never follows a redirect", () => {
	test("307 from the gateway: not allowed, nothing sent on (no body, no key)", async () => {
		const backend = new JevBackend({
			apiKey: "sk-test-key",
			url: `http://127.0.0.1:${redirecting.port}/v1/evaluate`,
		});
		const r = await bashGuard("make build", createDecider({ backend, cacheSize: 0 }));
		// The judge could not answer, so the guard fails closed: never allow.
		expect(r.verdict).not.toBe("allow");
		expect(r.backend).toBe("unavailable");
		expect(elsewhereHits).toEqual([]);
	});

	test("every 3xx is unavailable, even when a fetch hands one back", async () => {
		for (const status of [301, 302, 303, 307, 308]) {
			const backend = new JevBackend({
				apiKey: "sk-test-key",
				fetch: async () =>
					new Response(null, { status, headers: { location: "http://127.0.0.1:1/x" } }),
			});
			const r = await bashGuard("make build", createDecider({ backend, cacheSize: 0 }));
			expect({ status, verdict: r.verdict }).not.toEqual({ status, verdict: "allow" });
			expect(r.backend).toBe("unavailable");
		}
	});

	test("the request asks the runtime to error on a redirect", async () => {
		let seen: RequestInit | undefined;
		const backend = new JevBackend({
			apiKey: "sk-test-key",
			fetch: async (_url, init) => {
				seen = init;
				return new Response("{}", { status: 500 });
			},
		});
		await bashGuard("make build", createDecider({ backend, cacheSize: 0 }));
		expect(seen?.redirect).toBe("error");
	});
});

describe("other judge and proxy fetches refuse a redirect too", () => {
	test("SeleneJudge /api/generate: fails closed, nothing sent on", async () => {
		const judge = new SeleneJudge({ baseUrl: `http://127.0.0.1:${redirecting.port}` });
		const v = await judge.judge("output", "rubric");
		expect(v.pass).toBe(false);
		expect(v.source).toBe("fail-closed");
		expect(elsewhereHits).toEqual([]);
	});

	test("SkyworkScorer /pooling: no score, nothing sent on", async () => {
		const s = new SkyworkScorer({ baseUrl: `http://127.0.0.1:${redirecting.port}` });
		expect(await s.scoreOne("output")).toBeNull();
		expect(elsewhereHits).toEqual([]);
	});

	test("kernel JudgeScorer reachability check keeps its key to itself", async () => {
		const j = new JudgeScorer({
			prmUrl: `http://127.0.0.1:${redirecting.port}`,
			prmApiKey: "sk-test-key",
		});
		expect(await j.isAvailable()).toBe(false);
		expect(elsewhereHits).toEqual([]);
	});

	test("board vessel model proxy: refuses, nothing sent on", async () => {
		const saved = { ...process.env };
		process.env.MODEL_PROXY_URL = `http://127.0.0.1:${redirecting.port}`;
		process.env.INFERENCE_MODE = "proxy";
		try {
			await expect(
				generateResponse({ systemPrompt: "s", contextMessages: [], userMessage: "make build" }),
			).rejects.toThrow();
		} finally {
			for (const k of ["MODEL_PROXY_URL", "INFERENCE_MODE"])
				if (saved[k] === undefined) delete process.env[k];
				else process.env[k] = saved[k];
		}
		expect(elsewhereHits).toEqual([]);
	});
});
