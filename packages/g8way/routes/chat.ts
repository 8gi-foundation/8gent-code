/**
 * @8gent/g8way - POST /v1/chat/completions
 *
 * OpenAI-compatible chat completions endpoint. Validates model, checks
 * rate limit, forwards to OpenRouter, logs usage.
 *
 * Streaming: when `stream: true`, the upstream SSE body is piped back
 * to the client unchanged. Token accounting for streamed responses is
 * approximate (we only see the final usage chunk if OpenRouter sends
 * one) so we charge the up-front estimate and reconcile when possible.
 */

import type { Context, Hono } from "hono";
import { getTenant } from "../auth";
import type { OpenRouterClient } from "../openrouter";
import type { RateLimiter } from "../rate-limit";
import type {
	G8wayConfig,
	OpenAIChatRequest,
	OpenAIUsage,
	UsageRecord,
} from "../types";
import type { UsageLogger } from "../usage";

interface Deps {
	config: G8wayConfig;
	openrouter: OpenRouterClient;
	limiter: RateLimiter;
	logger: UsageLogger;
}

function badRequest(c: Context, message: string, code = "invalid_request") {
	return c.json(
		{ error: { message, type: "invalid_request_error", code } },
		400,
	);
}

function rateLimited(
	c: Context,
	message: string,
	retryAfterSeconds: number,
) {
	c.header("Retry-After", String(retryAfterSeconds));
	return c.json(
		{ error: { message, type: "rate_limit_error", code: "rate_limit_exceeded" } },
		429,
	);
}

function pickModel(config: G8wayConfig, requested: string | undefined): string | null {
	const target = requested && requested.length > 0 ? requested : config.defaultModel;
	if (!config.allowedModels.includes(target)) return null;
	return target;
}

export function registerChatRoute(app: Hono, deps: Deps): void {
	app.post("/v1/chat/completions", async (c) => {
		const startedAt = Date.now();
		const tenant = getTenant(c);

		let body: OpenAIChatRequest;
		try {
			body = (await c.req.json()) as OpenAIChatRequest;
		} catch {
			return badRequest(c, "Request body must be valid JSON");
		}

		if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
			return badRequest(c, "messages must be a non-empty array");
		}

		const model = pickModel(deps.config, body.model);
		if (!model) {
			return badRequest(
				c,
				`Model "${body.model}" is not allowed. Allowed: ${deps.config.allowedModels.join(", ")}`,
				"model_not_allowed",
			);
		}

		const decision = deps.limiter.checkRequest(tenant.tenantId, tenant.plan);
		if (!decision.allowed) {
			deps.logger.log({
				ts: new Date().toISOString(),
				type: "g8way.usage",
				tenant_id: tenant.tenantId,
				clerk_user_id: tenant.clerkUserId,
				plan: tenant.plan,
				model_requested: body.model ?? deps.config.defaultModel,
				model_resolved: model,
				upstream: "openrouter",
				prompt_tokens: 0,
				completion_tokens: 0,
				total_tokens: 0,
				latency_ms: Date.now() - startedAt,
				status: 429,
				stream: body.stream === true,
				error: `rate_limit:${decision.limit}`,
			});
			return rateLimited(
				c,
				`Rate limit exceeded for ${decision.limit}. Retry in ${decision.retryAfterSeconds}s.`,
				decision.retryAfterSeconds,
			);
		}

		const upstreamReq: OpenAIChatRequest = { ...body, model };

		try {
			const upstream = await deps.openrouter.chatCompletions(upstreamReq);

			if (upstreamReq.stream) {
				const record: UsageRecord = {
					ts: new Date().toISOString(),
					type: "g8way.usage",
					tenant_id: tenant.tenantId,
					clerk_user_id: tenant.clerkUserId,
					plan: tenant.plan,
					model_requested: body.model ?? deps.config.defaultModel,
					model_resolved: model,
					upstream: "openrouter",
					prompt_tokens: 0,
					completion_tokens: 0,
					total_tokens: 0,
					latency_ms: Date.now() - startedAt,
					status: upstream.status,
					stream: true,
				};
				deps.logger.log(record);

				return new Response(upstream.body, {
					status: upstream.status,
					headers: {
						"content-type": upstream.headers.get("content-type") ?? "text/event-stream",
						"cache-control": "no-cache",
					},
				});
			}

			const json = upstream.json as { usage?: OpenAIUsage } | undefined;
			const usage: OpenAIUsage = json?.usage ?? {
				prompt_tokens: 0,
				completion_tokens: 0,
				total_tokens: 0,
			};

			deps.limiter.chargeTokens(tenant.tenantId, tenant.plan, usage.total_tokens);

			deps.logger.log({
				ts: new Date().toISOString(),
				type: "g8way.usage",
				tenant_id: tenant.tenantId,
				clerk_user_id: tenant.clerkUserId,
				plan: tenant.plan,
				model_requested: body.model ?? deps.config.defaultModel,
				model_resolved: model,
				upstream: "openrouter",
				prompt_tokens: usage.prompt_tokens,
				completion_tokens: usage.completion_tokens,
				total_tokens: usage.total_tokens,
				latency_ms: Date.now() - startedAt,
				status: upstream.status,
				stream: false,
			});

			return c.json(json ?? {}, upstream.status as 200);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			deps.logger.log({
				ts: new Date().toISOString(),
				type: "g8way.usage",
				tenant_id: tenant.tenantId,
				clerk_user_id: tenant.clerkUserId,
				plan: tenant.plan,
				model_requested: body.model ?? deps.config.defaultModel,
				model_resolved: model,
				upstream: "openrouter",
				prompt_tokens: 0,
				completion_tokens: 0,
				total_tokens: 0,
				latency_ms: Date.now() - startedAt,
				status: 502,
				stream: body.stream === true,
				error: message,
			});
			return c.json(
				{
					error: {
						message: `Upstream error: ${message}`,
						type: "upstream_error",
						code: "upstream_failure",
					},
				},
				502,
			);
		}
	});
}
