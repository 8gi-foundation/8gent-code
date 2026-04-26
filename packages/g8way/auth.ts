/**
 * @8gent/g8way - Clerk JWT auth middleware (Hono).
 *
 * Reuses `validateToken()` from @8gent/auth so we share one JWKS cache
 * and one verification path across the whole 8GI stack. The middleware
 * pulls a Bearer token off the Authorization header, verifies it via
 * Clerk's JWKS, and attaches a TenantContext to the Hono context.
 *
 * Tenant resolution policy:
 *   - org_id claim wins (Clerk organizations -> billable tenant)
 *   - else falls back to clerk user id (solo users == own tenant)
 *
 * Plan claim resolution:
 *   - public_metadata.plan if present
 *   - else "free"
 *
 * If `requireAuth` is false (dev mode), the middleware injects an
 * anonymous tenant context so downstream handlers can run unchanged.
 */

import { resolveAuthConfig, validateToken } from "@8gent/auth";
import type { Context, MiddlewareHandler, Next } from "hono";
import type { TenantContext } from "./types";

export interface AuthMiddlewareOptions {
	clerkFrontendApi: string;
	clerkPublishableKey: string;
	requireAuth: boolean;
	/** Override the verifier - tests inject a fake to avoid hitting Clerk. */
	verify?: (token: string) => Promise<TenantContext | null>;
}

/**
 * Standard error response shape, OpenAI-style so SDK clients see a
 * familiar object on 401/403/429.
 */
function errorResponse(c: Context, status: 401 | 403 | 429, code: string, message: string) {
	return c.json(
		{
			error: { message, type: "invalid_request_error", code },
		},
		status,
	);
}

function tenantFromPayload(payload: {
	sub: string;
	email: string;
	[k: string]: unknown;
}): TenantContext {
	const orgId =
		typeof payload.org_id === "string" && payload.org_id.length > 0
			? (payload.org_id as string)
			: undefined;

	const meta = (payload.public_metadata ?? payload.metadata ?? {}) as Record<string, unknown>;
	const planRaw = typeof meta.plan === "string" ? meta.plan.toLowerCase() : "free";
	const plan: TenantContext["plan"] =
		planRaw === "team" ? "team" : planRaw === "pro" ? "pro" : "free";

	return {
		tenantId: orgId ?? payload.sub,
		clerkUserId: payload.sub,
		email: payload.email ?? "",
		plan,
	};
}

export function clerkAuth(opts: AuthMiddlewareOptions): MiddlewareHandler {
	const verify =
		opts.verify ??
		(async (token: string) => {
			const cfg = resolveAuthConfig({
				clerkFrontendApi: opts.clerkFrontendApi,
				clerkPublishableKey: opts.clerkPublishableKey,
			});
			const payload = await validateToken(token, cfg);
			if (!payload) return null;
			return tenantFromPayload(payload as unknown as Parameters<typeof tenantFromPayload>[0]);
		});

	return async (c: Context, next: Next) => {
		if (!opts.requireAuth) {
			c.set("tenant", {
				tenantId: "anonymous",
				clerkUserId: "anonymous",
				email: "",
				plan: "free",
			} satisfies TenantContext);
			return next();
		}

		const header = c.req.header("Authorization") ?? c.req.header("authorization");
		if (!header || !header.toLowerCase().startsWith("bearer ")) {
			return errorResponse(c, 401, "missing_token", "Missing Authorization Bearer token");
		}

		const token = header.slice(7).trim();
		if (!token) {
			return errorResponse(c, 401, "missing_token", "Empty Bearer token");
		}

		const tenant = await verify(token);
		if (!tenant) {
			return errorResponse(c, 401, "invalid_token", "Invalid or expired token");
		}

		c.set("tenant", tenant);
		await next();
	};
}

/**
 * Convenience: pull the tenant context off Hono's context. Throws if
 * the auth middleware did not run (programmer error, not a runtime
 * concern).
 */
export function getTenant(c: Context): TenantContext {
	const tenant = c.get("tenant") as TenantContext | undefined;
	if (!tenant) {
		throw new Error("g8way: getTenant() called before clerkAuth() middleware");
	}
	return tenant;
}

// Exported for tests so they can build a payload without going through Clerk.
export const _internals = { tenantFromPayload };
