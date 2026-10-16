/**
 * Upstream router tests: prefix routing, key failover on 429, unset config
 * leaves the OpenRouter path untouched, and the request cannot pick a URL.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { hostedAllowed } from "../../providers/failover";
import { resolveConfig } from "../config";
import { OpenRouterClient } from "../openrouter";
import { RateLimiter } from "../rate-limit";
import { registerChatRoute } from "../routes/chat";
import type { TenantContext } from "../types";
import { loadUpstreams } from "../upstreams";
import { InMemoryUsageLogger } from "../usage";

const ok = (tag: string) =>
	new Response(
		JSON.stringify({
			id: tag,
			choices: [{ index: 0, message: { role: "assistant", content: tag }, finish_reason: "stop" }],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);

interface Call {
	url: string;
	auth: string | null;
}

function recorder(handler: (call: Call, n: number) => Response) {
	const calls: Call[] = [];
	const fetchImpl = (async (input: unknown, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		const call = { url: String(input), auth: headers.get("authorization") };
		calls.push(call);
		return handler(call, calls.length);
	}) as unknown as typeof fetch;
	return { calls, fetchImpl };
}

function harness(
	env: Record<string, string | undefined>,
	rec: ReturnType<typeof recorder>,
	orRec = recorder(() => ok("openrouter")),
) {
	const logger = new InMemoryUsageLogger();
	const config = resolveConfig({
		openrouterApiKey: "or_key",
		allowedModels: ["anthropic/claude-sonnet-4-6", "local/qwen", "lab/big"],
		requireAuth: false,
	});
	const tenant: TenantContext = { tenantId: "t", clerkUserId: "u", email: "e@x.dev", plan: "pro" };
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("tenant" as never, tenant as never);
		await next();
	});
	registerChatRoute(app, {
		config,
		openrouter: new OpenRouterClient({
			apiKey: "or_key",
			baseUrl: config.openrouterBaseUrl,
			fetchImpl: orRec.fetchImpl,
		}),
		limiter: new RateLimiter(config.rateLimits),
		logger,
		upstreams: loadUpstreams(env, { fetchImpl: rec.fetchImpl }),
	});
	const post = (body: unknown) =>
		app.request("/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	return { post, logger, orCalls: orRec.calls };
}

const msg = [{ role: "user", content: "hi" }];

describe("upstreams", () => {
	test("routes by model prefix; unmatched models stay on OpenRouter", async () => {
		const rec = recorder(() => ok("local"));
		const env = {
			G8WAY_UPSTREAMS: JSON.stringify([
				{ name: "lmstudio", baseUrl: "http://127.0.0.1:1234/v1", prefixes: ["local/"] },
			]),
		};
		const h = harness(env, rec);
		const a = await h.post({ model: "local/qwen", messages: msg });
		expect(a.status).toBe(200);
		expect(rec.calls[0]?.url).toBe("http://127.0.0.1:1234/v1/chat/completions");
		expect(h.orCalls).toHaveLength(0);
		expect((h.logger.records[0] as { upstream: string }).upstream).toBe("lmstudio");

		await h.post({ model: "anthropic/claude-sonnet-4-6", messages: msg });
		expect(h.orCalls).toHaveLength(1);
		expect(rec.calls).toHaveLength(1);
		expect((h.logger.records[1] as { upstream: string }).upstream).toBe("openrouter");
	});

	test("longest prefix wins between two upstreams", () => {
		const rec = recorder(() => ok("x"));
		const r = loadUpstreams(
			{
				G8WAY_UPSTREAMS: JSON.stringify([
					{ name: "a", baseUrl: "http://127.0.0.1:1/v1", prefixes: ["lab/"] },
					{ name: "b", baseUrl: "http://127.0.0.1:2/v1", prefixes: ["lab/big"] },
				]),
			},
			{ fetchImpl: rec.fetchImpl },
		);
		expect(r?.resolve("lab/big")?.name).toBe("b");
		expect(r?.resolve("lab/small")?.name).toBe("a");
		expect(r?.resolve("other/x")).toBeNull();
	});

	test("429 on key A fails over to key B, and A cools down", async () => {
		const rec = recorder((call) =>
			call.auth === "Bearer key-a" ? new Response("{}", { status: 429 }) : ok("served-by-b"),
		);
		const env = {
			G8WAY_UPSTREAMS: JSON.stringify([
				{
					name: "pool",
					baseUrl: "http://127.0.0.1:9/v1",
					prefixes: ["local/"],
					keysEnv: "POOL_KEYS",
				},
			]),
			POOL_KEYS: "key-a,key-b",
		};
		const h = harness(env, rec);
		const res = await h.post({ model: "local/qwen", messages: msg });
		expect(res.status).toBe(200);
		expect(rec.calls.map((c) => c.auth)).toEqual(["Bearer key-a", "Bearer key-b"]);
		// next request skips the cooling key
		await h.post({ model: "local/qwen", messages: msg });
		expect(rec.calls.map((c) => c.auth)).toEqual(["Bearer key-a", "Bearer key-b", "Bearer key-b"]);
		expect(JSON.stringify(h.logger.records)).not.toContain("key-a");
	});

	test("all keys 429 returns 429, not a crash", async () => {
		const rec = recorder(() => new Response("{}", { status: 429 }));
		const env = {
			G8WAY_UPSTREAMS: JSON.stringify([
				{ name: "pool", baseUrl: "http://127.0.0.1:9/v1", prefixes: ["local/"], keysEnv: "K" },
			]),
			K: "k1,k2",
		};
		const h = harness(env, rec);
		const res = await h.post({ model: "local/qwen", messages: msg });
		expect(res.status).toBe(429);
		expect(rec.calls).toHaveLength(2);
	});

	test("unset G8WAY_UPSTREAMS: no router, OpenRouter path unchanged", async () => {
		expect(loadUpstreams({}, {})).toBeNull();
		const rec = recorder(() => ok("never"));
		const h = harness({}, rec);
		const res = await h.post({ model: "local/qwen", messages: msg });
		expect(res.status).toBe(200);
		expect(rec.calls).toHaveLength(0);
		expect(h.orCalls[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
		expect(h.orCalls[0]?.auth).toBe("Bearer or_key");
		expect((h.logger.records[0] as { upstream: string }).upstream).toBe("openrouter");
	});

	test("request body cannot choose the upstream URL", async () => {
		const rec = recorder(() => ok("local"));
		const env = {
			G8WAY_UPSTREAMS: JSON.stringify([
				{ name: "lm", baseUrl: "http://127.0.0.1:1234/v1", prefixes: ["local/"] },
			]),
		};
		const h = harness(env, rec);
		await h.post({
			model: "local/qwen",
			messages: msg,
			baseUrl: "http://169.254.169.254/",
			upstream: "http://evil.example",
		});
		expect(rec.calls).toHaveLength(1);
		expect(rec.calls[0]?.url).toBe("http://127.0.0.1:1234/v1/chat/completions");
	});

	test("hosted upstream is refused unless EIGHT_ALLOW_HOSTED=1", () => {
		const cfg = JSON.stringify([
			{ name: "cloud", baseUrl: "https://api.example.com/v1", prefixes: ["lab/"], keysEnv: "K" },
		]);
		expect(() => loadUpstreams({ G8WAY_UPSTREAMS: cfg, K: "k" }, {})).toThrow(/EIGHT_ALLOW_HOSTED/);
		expect(
			loadUpstreams({ G8WAY_UPSTREAMS: cfg, K: "k", EIGHT_ALLOW_HOSTED: "1" }, {}),
		).not.toBeNull();
	});

	test("hosted upstream without keys, bad URLs and bad JSON fail closed", () => {
		const hosted = (extra: object) =>
			JSON.stringify([
				{ name: "c", baseUrl: "https://api.example.com/v1", prefixes: ["x/"], ...extra },
			]);
		const allow = { EIGHT_ALLOW_HOSTED: "1" };
		expect(() => loadUpstreams({ ...allow, G8WAY_UPSTREAMS: hosted({}) }, {})).toThrow(/key/);
		expect(() =>
			loadUpstreams({ ...allow, K: "", G8WAY_UPSTREAMS: hosted({ keysEnv: "K" }) }, {}),
		).toThrow(/key/);
		expect(() =>
			loadUpstreams(
				{
					G8WAY_UPSTREAMS: JSON.stringify([
						{ name: "c", baseUrl: "file:///etc", prefixes: ["x/"] },
					]),
				},
				{},
			),
		).toThrow(/baseUrl/);
		expect(() => loadUpstreams({ G8WAY_UPSTREAMS: "{nope" }, {})).toThrow(/G8WAY_UPSTREAMS/);
	});

	test("literal keys in config JSON are rejected", () => {
		expect(() =>
			loadUpstreams(
				{
					G8WAY_UPSTREAMS: JSON.stringify([
						{ name: "a", baseUrl: "http://127.0.0.1:1/v1", prefixes: ["x/"], apiKey: "sk-secret" },
					]),
				},
				{},
			),
		).toThrow(/keysEnv/);
	});

	test("upstream fetches use redirect: error", async () => {
		let seen: RequestInit | undefined;
		const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
			seen = init;
			return ok("x");
		}) as unknown as typeof fetch;
		const r = loadUpstreams(
			{
				G8WAY_UPSTREAMS: JSON.stringify([
					{ name: "a", baseUrl: "http://127.0.0.1:1/v1", prefixes: ["x/"] },
				]),
			},
			{ fetchImpl },
		);
		await r?.resolve("x/1")?.chatCompletions({ model: "x/1", messages: [] });
		expect(seen?.redirect).toBe("error");
	});

	test("http is allowed only on loopback", () => {
		const cfg = (baseUrl: string) =>
			JSON.stringify([{ name: "a", baseUrl, prefixes: ["x/"], keysEnv: "K" }]);
		const env = { EIGHT_ALLOW_HOSTED: "1", K: "k" };
		expect(() =>
			loadUpstreams({ ...env, G8WAY_UPSTREAMS: cfg("http://api.example.com/v1") }, {}),
		).toThrow(/https/);
		expect(
			loadUpstreams({ ...env, G8WAY_UPSTREAMS: cfg("https://api.example.com/v1") }, {}),
		).not.toBeNull();
		expect(loadUpstreams({ G8WAY_UPSTREAMS: cfg("http://localhost:1/v1") }, {})).not.toBeNull();
	});

	test("routed upstream failure does not leak baseUrl to the tenant, full error is logged", async () => {
		const rec = recorder(() => {
			throw new Error("connect failed http://127.0.0.1:1234/v1");
		});
		const env = {
			G8WAY_UPSTREAMS: JSON.stringify([
				{ name: "lm", baseUrl: "http://127.0.0.1:1234/v1", prefixes: ["local/"] },
			]),
		};
		const h = harness(env, rec);
		const res = await h.post({ model: "local/qwen", messages: msg });
		expect(res.status).toBe(502);
		expect(await res.text()).not.toContain("127.0.0.1");
		expect(JSON.stringify(h.logger.records[0])).toContain("127.0.0.1:1234");
	});

	test("rate-limit audit line names the routed upstream", async () => {
		const rec = recorder(() => ok("x"));
		const env = {
			G8WAY_UPSTREAMS: JSON.stringify([
				{ name: "lm", baseUrl: "http://127.0.0.1:1234/v1", prefixes: ["local/"] },
			]),
		};
		const h = harness(env, rec);
		let last = 200;
		for (let i = 0; i < 400 && last !== 429; i++) {
			last = (await h.post({ model: "local/qwen", messages: msg })).status;
		}
		expect(last).toBe(429);
		const line = h.logger.records[h.logger.records.length - 1] as {
			upstream: string;
			status: number;
		};
		expect(line.status).toBe(429);
		expect(line.upstream).toBe("lm");
	});

	test("429 response body is cancelled before the next key", async () => {
		let cancelled = false;
		const rec = recorder((call) =>
			call.auth === "Bearer key-a"
				? new Response(
						new ReadableStream({
							cancel() {
								cancelled = true;
							},
						}),
						{ status: 429 },
					)
				: ok("b"),
		);
		const env = {
			G8WAY_UPSTREAMS: JSON.stringify([
				{ name: "p", baseUrl: "http://127.0.0.1:9/v1", prefixes: ["local/"], keysEnv: "K" },
			]),
			K: "key-a,key-b",
		};
		const h = harness(env, rec);
		await h.post({ model: "local/qwen", messages: msg, stream: true });
		expect(cancelled).toBe(true);
	});

	test("routed upstream 401 and 403 become a generic 502 with no upstream text", async () => {
		for (const status of [401, 403]) {
			const rec = recorder(
				() => new Response(JSON.stringify({ error: "bad key sk-abc...XYZ" }), { status }),
			);
			const env = {
				G8WAY_UPSTREAMS: JSON.stringify([
					{ name: "lm", baseUrl: "http://127.0.0.1:1234/v1", prefixes: ["local/"] },
				]),
			};
			const h = harness(env, rec);
			const res = await h.post({ model: "local/qwen", messages: msg });
			expect(res.status).toBe(502);
			expect(await res.text()).not.toContain("sk-abc");
		}
	});

	test("hosted gate uses the providers hostedAllowed truthiness", () => {
		const cfg = JSON.stringify([
			{ name: "c", baseUrl: "https://api.example.com/v1", prefixes: ["x/"], keysEnv: "K" },
		]);
		for (const v of ["1", " 1 ", "true", "0", undefined]) {
			const env = { G8WAY_UPSTREAMS: cfg, K: "k", EIGHT_ALLOW_HOSTED: v };
			let allowed = true;
			try {
				loadUpstreams(env, {});
			} catch {
				allowed = false;
			}
			expect(allowed).toBe(hostedAllowed(env));
		}
	});
});
