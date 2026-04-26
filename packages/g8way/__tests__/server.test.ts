/**
 * End-to-end route tests against the in-memory Hono app. We inject a
 * fake `fetch` so OpenRouter is never actually called, plus an
 * InMemoryUsageLogger so we can assert on the audit trail.
 */

import { describe, expect, test } from "bun:test";
import { createApp } from "../server";
import type { TenantContext } from "../types";
import { InMemoryUsageLogger } from "../usage";

const fakeOpenRouterResponse = {
	id: "chatcmpl-test",
	object: "chat.completion",
	created: 1_700_000_000,
	model: "anthropic/claude-sonnet-4-6",
	choices: [
		{
			index: 0,
			message: { role: "assistant", content: "hello back" },
			finish_reason: "stop",
		},
	],
	usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
};

function buildHarness(opts: { tenantPlan?: TenantContext["plan"] } = {}) {
	const logger = new InMemoryUsageLogger();
	let lastRequest: { url: string; init?: RequestInit } | null = null;

	const fakeFetch = (async (input: unknown, init?: unknown) => {
		lastRequest = { url: String(input), init: init as RequestInit | undefined };
		return new Response(JSON.stringify(fakeOpenRouterResponse), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as unknown as typeof fetch;

	const tenant: TenantContext = {
		tenantId: "tenant_test",
		clerkUserId: "user_test",
		email: "test@8gent.dev",
		plan: opts.tenantPlan ?? "pro",
	};

	const built = createApp({
		config: {
			openrouterApiKey: "or_test",
			clerkPublishableKey: "pk_test",
			requireAuth: true,
		},
		logger,
		openrouterFetch: fakeFetch,
		authVerify: async () => tenant,
	});

	return { ...built, logger, tenant, getLastUpstream: () => lastRequest };
}

describe("g8way server", () => {
	test("GET /healthz works without auth", async () => {
		const { app } = buildHarness();
		const res = await app.request("/healthz");
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ status: "ok", service: "g8way" });
	});

	test("GET /v1/models requires a token", async () => {
		const { app } = buildHarness();
		const res = await app.request("/v1/models");
		expect(res.status).toBe(401);
	});

	test("GET /v1/models lists configured models", async () => {
		const { app, config } = buildHarness();
		const res = await app.request("/v1/models", {
			headers: { Authorization: "Bearer any" },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { data: Array<{ id: string }> };
		expect(body.data.map((m) => m.id)).toEqual(config.allowedModels);
	});

	test("POST /v1/chat/completions forwards to upstream and logs usage", async () => {
		const { app, logger, getLastUpstream } = buildHarness();
		const res = await app.request("/v1/chat/completions", {
			method: "POST",
			headers: {
				Authorization: "Bearer any",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: "anthropic/claude-sonnet-4-6",
				messages: [{ role: "user", content: "hi" }],
			}),
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as typeof fakeOpenRouterResponse;
		expect(body.choices[0]?.message.content).toBe("hello back");

		expect(getLastUpstream()?.url).toContain("/chat/completions");

		expect(logger.records).toHaveLength(1);
		const log = logger.records[0];
		expect(log).toMatchObject({
			tenant_id: "tenant_test",
			model_resolved: "anthropic/claude-sonnet-4-6",
			prompt_tokens: 12,
			completion_tokens: 8,
			total_tokens: 20,
			status: 200,
			stream: false,
		});
	});

	test("rejects disallowed models with 400", async () => {
		const { app } = buildHarness();
		const res = await app.request("/v1/chat/completions", {
			method: "POST",
			headers: {
				Authorization: "Bearer any",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: "evil-corp/secret-model",
				messages: [{ role: "user", content: "x" }],
			}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("model_not_allowed");
	});

	test("rejects empty messages with 400", async () => {
		const { app } = buildHarness();
		const res = await app.request("/v1/chat/completions", {
			method: "POST",
			headers: {
				Authorization: "Bearer any",
				"content-type": "application/json",
			},
			body: JSON.stringify({ messages: [] }),
		});
		expect(res.status).toBe(400);
	});

	test("returns 429 once tenant blows the rate limit", async () => {
		const { app, logger } = buildHarness({ tenantPlan: "free" });
		const send = () =>
			app.request("/v1/chat/completions", {
				method: "POST",
				headers: {
					Authorization: "Bearer any",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					model: "anthropic/claude-sonnet-4-6",
					messages: [{ role: "user", content: "x" }],
				}),
			});

		// free tier defaults to 20 RPM in resolveConfig
		for (let i = 0; i < 20; i++) {
			const r = await send();
			expect(r.status).toBe(200);
		}
		const r = await send();
		expect(r.status).toBe(429);
		expect(r.headers.get("Retry-After")).not.toBeNull();
		const blocked = logger.records.find((rec) => rec.status === 429);
		expect(blocked?.error).toContain("rate_limit");
	});

	test("upstream failure surfaces as 502 with logged error", async () => {
		const logger = new InMemoryUsageLogger();
		const failingFetch = (async () => {
			throw new Error("network down");
		}) as unknown as typeof fetch;
		const tenant: TenantContext = {
			tenantId: "t",
			clerkUserId: "u",
			email: "e",
			plan: "pro",
		};
		const { app } = createApp({
			config: { openrouterApiKey: "x", clerkPublishableKey: "x", requireAuth: true },
			logger,
			openrouterFetch: failingFetch,
			authVerify: async () => tenant,
		});

		const res = await app.request("/v1/chat/completions", {
			method: "POST",
			headers: {
				Authorization: "Bearer any",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: "anthropic/claude-sonnet-4-6",
				messages: [{ role: "user", content: "x" }],
			}),
		});
		expect(res.status).toBe(502);
		expect(logger.records[0]?.error).toBe("network down");
	});
});
