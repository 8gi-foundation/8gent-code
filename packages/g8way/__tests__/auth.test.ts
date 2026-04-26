/**
 * Auth middleware tests. Verifies Clerk JWT extraction, tenant
 * resolution (org_id wins over sub), plan claim parsing, and the 401
 * paths. Uses the `verify` injection point so we never hit the network.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { _internals, clerkAuth, getTenant } from "../auth";
import type { TenantContext } from "../types";

function buildApp(verify: (token: string) => Promise<TenantContext | null>) {
	const app = new Hono();
	app.use(
		"*",
		clerkAuth({
			clerkFrontendApi: "https://clerk.test",
			clerkPublishableKey: "pk_test_x",
			requireAuth: true,
			verify,
		}),
	);
	app.get("/who", (c) => c.json(getTenant(c)));
	return app;
}

describe("clerkAuth middleware", () => {
	test("rejects missing Authorization header with 401", async () => {
		const app = buildApp(async () => null);
		const res = await app.request("/who");
		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("missing_token");
	});

	test("rejects non-Bearer scheme with 401", async () => {
		const app = buildApp(async () => null);
		const res = await app.request("/who", {
			headers: { Authorization: "Basic abc" },
		});
		expect(res.status).toBe(401);
	});

	test("rejects invalid token with 401", async () => {
		const app = buildApp(async () => null);
		const res = await app.request("/who", {
			headers: { Authorization: "Bearer bad-token" },
		});
		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("invalid_token");
	});

	test("attaches tenant context on valid token", async () => {
		const tenant: TenantContext = {
			tenantId: "user_abc",
			clerkUserId: "user_abc",
			email: "j@8gent.dev",
			plan: "pro",
		};
		const app = buildApp(async () => tenant);
		const res = await app.request("/who", {
			headers: { Authorization: "Bearer any" },
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(tenant);
	});

	test("anonymous mode bypasses auth when requireAuth=false", async () => {
		const app = new Hono();
		app.use(
			"*",
			clerkAuth({
				clerkFrontendApi: "https://clerk.test",
				clerkPublishableKey: "pk_test_x",
				requireAuth: false,
			}),
		);
		app.get("/who", (c) => c.json(getTenant(c)));
		const res = await app.request("/who");
		expect(res.status).toBe(200);
		const body = (await res.json()) as TenantContext;
		expect(body.tenantId).toBe("anonymous");
	});
});

describe("tenantFromPayload", () => {
	test("uses org_id when present", () => {
		const t = _internals.tenantFromPayload({
			sub: "user_1",
			email: "x@y.z",
			org_id: "org_42",
		});
		expect(t.tenantId).toBe("org_42");
		expect(t.clerkUserId).toBe("user_1");
	});

	test("falls back to sub when no org_id", () => {
		const t = _internals.tenantFromPayload({
			sub: "user_1",
			email: "x@y.z",
		});
		expect(t.tenantId).toBe("user_1");
	});

	test("parses plan from public_metadata", () => {
		const t = _internals.tenantFromPayload({
			sub: "u",
			email: "x@y.z",
			public_metadata: { plan: "team" },
		});
		expect(t.plan).toBe("team");
	});

	test("defaults plan to free for unknown values", () => {
		const t = _internals.tenantFromPayload({
			sub: "u",
			email: "x@y.z",
			public_metadata: { plan: "enterprise-mega-deluxe" },
		});
		expect(t.plan).toBe("free");
	});
});
