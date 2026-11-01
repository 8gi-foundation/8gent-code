/**
 * Convex tenant row adapter. Calls a Convex HTTP mutation to upsert a tenant
 * row keyed by handle. The mutation must be implemented on the Convex side as
 * `tenants:upsertByHandle`. If the deployment URL or service key is missing,
 * the adapter falls back to a dry-run-only plan step.
 *
 * The mutation is expected to be idempotent: passing the same handle twice
 * should return the same tenantId rather than creating a duplicate.
 */
import type { Adapter, Ctx, PlanStep } from "./types.ts";
import { tenantId } from "./handle.ts";

interface ConvexResult {
	status: "success" | "error";
	value?: { tenantId: string; created: boolean };
	errorMessage?: string;
}

async function callMutation(
	ctx: Ctx,
	url: string,
	key: string,
	handle: string,
): Promise<{ tenantId: string; created: boolean }> {
	const res = await ctx.fetch(`${url.replace(/\/$/, "")}/api/mutation`, {
		method: "POST",
		headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			path: "tenants:upsertByHandle",
			args: { handle, tenantId: tenantId(handle), provisionedAt: ctx.now().toISOString() },
			format: "json",
		}),
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Convex mutation HTTP ${res.status}: ${body}`);
	}
	const data = (await res.json()) as ConvexResult;
	if (data.status !== "success" || !data.value) {
		throw new Error(`Convex mutation error: ${data.errorMessage ?? "unknown"}`);
	}
	return data.value;
}

export const convexAdapter: Adapter = {
	name: "convex-tenant",
	async plan(handle, ctx): Promise<PlanStep> {
		const url = ctx.env.NEXT_PUBLIC_CONVEX_URL ?? ctx.env.CONVEX_URL;
		const key = ctx.env.VESSEL_CONVEX_SERVICE_KEY ?? ctx.env.CONVEX_DEPLOY_KEY;
		const id = tenantId(handle);

		if (!url || !key) {
			return ctx.apply
				? errStep(handle, "NEXT_PUBLIC_CONVEX_URL and VESSEL_CONVEX_SERVICE_KEY (or CONVEX_DEPLOY_KEY) required for --apply")
				: { resource: `convex:${id}`, status: "create", detail: `would upsert tenants row tenantId=${id} (dry-run, no API call)` };
		}

		if (!ctx.apply) {
			return { resource: `convex:${id}`, status: "create", detail: `would upsert tenants row tenantId=${id}` };
		}

		try {
			const result = await callMutation(ctx, url, key, handle);
			return {
				resource: `convex:${result.tenantId}`,
				status: result.created ? "create" : "exists",
				detail: result.created ? `created tenants row ${result.tenantId}` : `tenants row ${result.tenantId} already present`,
			};
		} catch (e) {
			return errStep(handle, (e as Error).message);
		}
	},
};

function errStep(handle: string, msg: string): PlanStep {
	return { resource: `convex:${tenantId(handle)}`, status: "error", detail: "Convex step failed", error: msg };
}
