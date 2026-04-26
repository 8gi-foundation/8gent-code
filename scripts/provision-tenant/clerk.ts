/**
 * Clerk organization adapter. Creates an org with slug = handle.
 * Idempotent: GET /v1/organizations?query=<handle> first; if any org has the
 * exact slug, treat as exists.
 */
import type { Adapter, Ctx, PlanStep } from "./types.ts";

const CLERK_API = "https://api.clerk.com/v1";

interface ClerkOrg {
	id: string;
	slug: string;
	name: string;
}

async function findOrg(ctx: Ctx, key: string, slug: string): Promise<ClerkOrg | null> {
	const res = await ctx.fetch(`${CLERK_API}/organizations?query=${encodeURIComponent(slug)}&limit=50`, {
		headers: { Authorization: `Bearer ${key}` },
	});
	if (!res.ok) throw new Error(`Clerk org lookup failed: ${res.status}`);
	const data = (await res.json()) as { data?: ClerkOrg[] };
	return data.data?.find((o) => o.slug === slug) ?? null;
}

async function createOrg(ctx: Ctx, key: string, handle: string, createdBy: string): Promise<ClerkOrg> {
	const res = await ctx.fetch(`${CLERK_API}/organizations`, {
		method: "POST",
		headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
		body: JSON.stringify({ name: handle, slug: handle, created_by: createdBy }),
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Clerk org create failed: ${res.status} ${body}`);
	}
	return (await res.json()) as ClerkOrg;
}

export const clerkAdapter: Adapter = {
	name: "clerk-org",
	async plan(handle, ctx): Promise<PlanStep> {
		const key = ctx.env.CLERK_SECRET_KEY;
		const createdBy = ctx.env.CLERK_FOUNDATION_USER_ID;

		if (!key) {
			return ctx.apply
				? err(handle, "CLERK_SECRET_KEY required for --apply")
				: { resource: `clerk:${handle}`, status: "create", detail: "would create Clerk org (dry-run, no API call)" };
		}

		try {
			const existing = await findOrg(ctx, key, handle);
			if (existing) {
				return { resource: `clerk:${handle}`, status: "exists", detail: `org ${existing.id} (slug=${existing.slug})` };
			}
			if (!ctx.apply) {
				return { resource: `clerk:${handle}`, status: "create", detail: "would create Clerk org" };
			}
			if (!createdBy) {
				return err(handle, "CLERK_FOUNDATION_USER_ID required for org creation (Clerk requires a creator)");
			}
			const org = await createOrg(ctx, key, handle, createdBy);
			return { resource: `clerk:${handle}`, status: "create", detail: `created org ${org.id}` };
		} catch (e) {
			return err(handle, (e as Error).message);
		}
	},
};

function err(handle: string, msg: string): PlanStep {
	return { resource: `clerk:${handle}`, status: "error", detail: "Clerk step failed", error: msg };
}
