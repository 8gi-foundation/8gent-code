/**
 * Tests for Wave 4 B-2 tenant provisioning script. All five adapters are
 * exercised against a mock fetch + a temp directory. The tests assert:
 *   1. Handle validation rejects garbage
 *   2. Dry-run never calls fetch with a mutating method
 *   3. Idempotency: re-running dry-run when resources exist yields exists
 *   4. Apply path: mutating calls fire and minute reports created
 *   5. Minute draft is written and contains the right tenant + table
 *   6. CLI arg parser handles --handle, positional, and --apply
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTERS, parseArgs, provisionTenant, summarize } from "./index.ts";
import { renderMinute } from "./minute.ts";
import { validateHandle, tenantId, subdomain, bucketName } from "./handle.ts";
import type { Ctx, ProvisionOptions } from "./types.ts";

const FIXED_NOW = new Date("2026-04-26T16:30:00.000Z");

function makeCtx(overrides: Partial<Ctx> & { rootDir: string; fetch: typeof fetch }): Partial<Ctx> {
	return {
		env: overrides.env ?? {},
		fetch: overrides.fetch,
		now: () => FIXED_NOW,
		logger: { info: () => {}, warn: () => {}, error: () => {} },
		...overrides,
	};
}

interface FetchCall {
	url: string;
	method: string;
}

function recordingFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): {
	fetch: typeof fetch;
	calls: FetchCall[];
} {
	const calls: FetchCall[] = [];
	const fn: typeof fetch = async (input: any, init?: any) => {
		const url = typeof input === "string" ? input : input.url;
		calls.push({ url, method: (init?.method as string) ?? "GET" });
		return handler(url, init);
	};
	return { fetch: fn, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let tmp: string;
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "provision-tenant-"));
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

// ────── handle validation ─────────────────────────────────────────────

describe("handle validation", () => {
	test("accepts valid handles", () => {
		expect(validateHandle("james")).toBe("james");
		expect(validateHandle("Darragh")).toBe("darragh");
		expect(validateHandle("kris-ten-1")).toBe("kris-ten-1");
	});

	test("derives consistent ids", () => {
		expect(tenantId("james")).toBe("tenant_james");
		expect(subdomain("james")).toBe("james.8gentos.com");
		expect(bucketName("james")).toBe("tenant-james");
	});

	test("rejects garbage", () => {
		expect(() => validateHandle("")).toThrow();
		expect(() => validateHandle("a")).toThrow();
		expect(() => validateHandle("-leading-dash")).toThrow();
		expect(() => validateHandle("trailing-dash-")).toThrow();
		expect(() => validateHandle("has space")).toThrow();
		expect(() => validateHandle("has.dot")).toThrow();
		expect(() => validateHandle("UPPER123ALLOWED")).not.toThrow();
		expect(() => validateHandle("a".repeat(64))).toThrow();
	});
});

// ────── CLI parser ────────────────────────────────────────────────────

describe("parseArgs", () => {
	test("--handle flag", () => {
		const o = parseArgs(["--handle", "james"]);
		expect(o.handle).toBe("james");
		expect(o.apply).toBe(false);
	});

	test("--handle=value form", () => {
		const o = parseArgs(["--handle=james"]);
		expect(o.handle).toBe("james");
	});

	test("positional handle", () => {
		const o = parseArgs(["james"]);
		expect(o.handle).toBe("james");
	});

	test("--apply flips apply", () => {
		const o = parseArgs(["--handle", "james", "--apply"]);
		expect(o.apply).toBe(true);
	});

	test("missing handle throws", () => {
		expect(() => parseArgs([])).toThrow(/Missing --handle/);
	});
});

// ────── dry-run end-to-end ────────────────────────────────────────────

describe("provisionTenant dry-run with no env", () => {
	test("plans creates for everything, mutates nothing remote, writes minute", async () => {
		const { fetch, calls } = recordingFetch(() => new Response("should not be called", { status: 599 }));
		const opts: ProvisionOptions = { handle: "james", apply: false, rootDir: tmp };
		const { plan, minutePath } = await provisionTenant(opts, makeCtx({ rootDir: tmp, fetch, env: {} }));

		expect(plan.handle).toBe("james");
		expect(plan.dryRun).toBe(true);
		expect(plan.steps).toHaveLength(5);
		const statuses = plan.steps.map((s) => `${s.resource}:${s.status}`).sort();
		expect(statuses).toEqual([
			"bucket:tenant-james:create",
			"clerk:james:create",
			"convex:tenant_james:create",
			"dns:james.8gentos.com:create",
			"telegram:james:create",
		]);
		// Dry-run with no env keys should not hit fetch at all.
		expect(calls).toHaveLength(0);
		// Telegram slot is the only step that writes locally even in dry-run? No - dry-run writes nothing.
		expect(existsSync(join(tmp, ".8gent", "tenants", "james", "telegram-bot-token.placeholder"))).toBe(false);
		// Minute draft is always written.
		expect(existsSync(minutePath)).toBe(true);
		const minute = readFileSync(minutePath, "utf8");
		expect(minute).toContain("# Tenant Provisioning Minute - james");
		expect(minute).toContain("DRAFT (dry-run)");
		expect(minute).toContain("dns:james.8gentos.com");
	});
});

// ────── apply path with mocked APIs ───────────────────────────────────

describe("provisionTenant --apply with mocked APIs", () => {
	test("creates everything when nothing exists", async () => {
		const { fetch, calls } = recordingFetch((url, init) => {
			const method = (init?.method as string) ?? "GET";
			// Hetzner DNS: zones lookup
			if (url.includes("dns.hetzner.com/api/v1/zones")) {
				return jsonResponse({ zones: [{ id: "zone1", name: "8gentos.com" }] });
			}
			// Hetzner DNS: records lookup -> empty
			if (url.includes("dns.hetzner.com/api/v1/records?")) {
				return jsonResponse({ records: [] });
			}
			// Hetzner DNS: create record
			if (url.includes("dns.hetzner.com/api/v1/records") && method === "POST") {
				return jsonResponse({ record: { id: "rec1" } });
			}
			// Clerk: org list -> empty
			if (url.includes("api.clerk.com/v1/organizations") && method === "GET") {
				return jsonResponse({ data: [] });
			}
			// Clerk: create org
			if (url.includes("api.clerk.com/v1/organizations") && method === "POST") {
				return jsonResponse({ id: "org_xyz", slug: "james", name: "james" });
			}
			// Convex mutation
			if (url.includes("/api/mutation")) {
				return jsonResponse({ status: "success", value: { tenantId: "tenant_james", created: true } });
			}
			// Hetzner S3 HEAD bucket -> 404
			if (url.includes("your-objectstorage.com") && method === "HEAD") {
				return new Response("", { status: 404 });
			}
			// Hetzner S3 PUT bucket -> 200
			if (url.includes("your-objectstorage.com") && method === "PUT") {
				return new Response("", { status: 200 });
			}
			return new Response(`unhandled: ${method} ${url}`, { status: 599 });
		});

		const opts: ProvisionOptions = { handle: "james", apply: true, rootDir: tmp };
		const env = {
			HETZNER_BOX_IP: "78.47.98.218",
			HETZNER_DNS_API_TOKEN: "dns-token",
			CLERK_SECRET_KEY: "sk_test_x",
			CLERK_FOUNDATION_USER_ID: "user_y",
			NEXT_PUBLIC_CONVEX_URL: "https://example.convex.cloud",
			VESSEL_CONVEX_SERVICE_KEY: "convex-key",
			HETZNER_S3_ACCESS_KEY: "ak",
			HETZNER_S3_SECRET_KEY: "sk",
		};
		const { plan } = await provisionTenant(opts, makeCtx({ rootDir: tmp, fetch, env }));

		const byResource = Object.fromEntries(plan.steps.map((s) => [s.resource, s]));
		expect(byResource["dns:james.8gentos.com"].status).toBe("create");
		expect(byResource["clerk:james"].status).toBe("create");
		expect(byResource["convex:tenant_james"].status).toBe("create");
		expect(byResource["telegram:james"].status).toBe("create");
		expect(byResource["bucket:tenant-james"].status).toBe("create");

		// Telegram slot file exists in apply mode.
		expect(existsSync(join(tmp, ".8gent", "tenants", "james", "telegram-bot-token.placeholder"))).toBe(true);

		// Sanity: at least one POST went to Clerk and one POST to Hetzner DNS.
		expect(calls.some((c) => c.method === "POST" && c.url.includes("clerk.com"))).toBe(true);
		expect(calls.some((c) => c.method === "POST" && c.url.includes("hetzner.com"))).toBe(true);
	});

	test("idempotent re-run reports exists for everything", async () => {
		// Simulate every resource already provisioned.
		const { fetch } = recordingFetch((url, init) => {
			const method = (init?.method as string) ?? "GET";
			if (url.includes("dns.hetzner.com/api/v1/zones")) {
				return jsonResponse({ zones: [{ id: "zone1", name: "8gentos.com" }] });
			}
			if (url.includes("dns.hetzner.com/api/v1/records?")) {
				return jsonResponse({ records: [{ id: "rec1", name: "james", type: "A", value: "78.47.98.218", zone_id: "zone1" }] });
			}
			if (url.includes("api.clerk.com/v1/organizations") && method === "GET") {
				return jsonResponse({ data: [{ id: "org_xyz", slug: "james", name: "james" }] });
			}
			if (url.includes("/api/mutation")) {
				return jsonResponse({ status: "success", value: { tenantId: "tenant_james", created: false } });
			}
			if (url.includes("your-objectstorage.com") && method === "HEAD") {
				return new Response("", { status: 200 });
			}
			return new Response(`unhandled: ${method} ${url}`, { status: 599 });
		});

		// Pre-create the telegram slot file to simulate prior reservation.
		const { mkdirSync, writeFileSync } = await import("node:fs");
		mkdirSync(join(tmp, ".8gent", "tenants", "james"), { recursive: true });
		writeFileSync(join(tmp, ".8gent", "tenants", "james", "telegram-bot-token.placeholder"), "old\n");

		const opts: ProvisionOptions = { handle: "james", apply: true, rootDir: tmp };
		const env = {
			HETZNER_BOX_IP: "78.47.98.218",
			HETZNER_DNS_API_TOKEN: "dns-token",
			CLERK_SECRET_KEY: "sk_test_x",
			CLERK_FOUNDATION_USER_ID: "user_y",
			NEXT_PUBLIC_CONVEX_URL: "https://example.convex.cloud",
			VESSEL_CONVEX_SERVICE_KEY: "convex-key",
			HETZNER_S3_ACCESS_KEY: "ak",
			HETZNER_S3_SECRET_KEY: "sk",
		};
		const { plan } = await provisionTenant(opts, makeCtx({ rootDir: tmp, fetch, env }));

		for (const step of plan.steps) {
			expect(step.status).toBe("exists");
		}
	});

	test("reports rotate when DNS A record points elsewhere", async () => {
		const { fetch } = recordingFetch((url) => {
			if (url.includes("dns.hetzner.com/api/v1/zones")) {
				return jsonResponse({ zones: [{ id: "zone1", name: "8gentos.com" }] });
			}
			if (url.includes("dns.hetzner.com/api/v1/records?")) {
				return jsonResponse({ records: [{ id: "rec1", name: "james", type: "A", value: "1.2.3.4", zone_id: "zone1" }] });
			}
			return new Response("ok", { status: 200 });
		});

		const opts: ProvisionOptions = { handle: "james", apply: false, rootDir: tmp };
		const env = { HETZNER_BOX_IP: "78.47.98.218", HETZNER_DNS_API_TOKEN: "t" };
		const { plan } = await provisionTenant(opts, makeCtx({ rootDir: tmp, fetch, env }));
		const dns = plan.steps.find((s) => s.resource.startsWith("dns:"))!;
		expect(dns.status).toBe("rotate");
		expect(dns.detail).toContain("1.2.3.4");
	});
});

// ────── minute renderer ───────────────────────────────────────────────

describe("renderMinute", () => {
	test("includes table row per step and chair", () => {
		const md = renderMinute({
			handle: "james",
			plan: {
				handle: "james",
				dryRun: true,
				steps: [
					{ resource: "dns:james.8gentos.com", status: "create", detail: "would create A record" },
					{ resource: "clerk:james", status: "exists", detail: "org_abc" },
				],
				startedAt: "2026-04-26T16:30:00.000Z",
				finishedAt: "2026-04-26T16:30:01.000Z",
			},
			chair: "James Spalding",
			officers: ["8TO Rishi"],
		});
		expect(md).toContain("# Tenant Provisioning Minute - james");
		expect(md).toContain("| dns:james.8gentos.com | create |");
		expect(md).toContain("| clerk:james | exists |");
		expect(md).toContain("**Chair:** James Spalding");
		expect(md).toContain("DRAFT (dry-run)");
	});
});

// ────── adapter registry ──────────────────────────────────────────────

describe("ADAPTERS", () => {
	test("exposes all five adapters in the documented order", () => {
		expect(ADAPTERS.map((a) => a.name)).toEqual([
			"hetzner-dns",
			"clerk-org",
			"convex-tenant",
			"telegram-slot",
			"hetzner-bucket",
		]);
	});
});

// ────── summarize ─────────────────────────────────────────────────────

describe("summarize", () => {
	test("counts each status", () => {
		const out = summarize({
			handle: "james",
			dryRun: true,
			steps: [
				{ resource: "a", status: "create", detail: "" },
				{ resource: "b", status: "create", detail: "" },
				{ resource: "c", status: "exists", detail: "" },
			],
			startedAt: "x",
			finishedAt: "y",
		});
		expect(out).toContain("tenant=james");
		expect(out).toContain("create=2");
		expect(out).toContain("exists=1");
	});
});
