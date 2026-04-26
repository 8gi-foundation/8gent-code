#!/usr/bin/env bun
/**
 * Wave 4 B-2: Tenant provisioning CLI entry point.
 *
 * Provisions a tenant across DNS, Clerk, Convex, Telegram bot slot, and Hetzner
 * Object Storage, then writes a boardroom minute draft. Dry-run by default;
 * pass --apply to mutate live infrastructure.
 *
 * Issue: https://github.com/8gi-foundation/8gent-OS/issues/113
 *
 * NOTE: B-2 lives in 8gent-code temporarily per James 2026-04-26. Will port to
 * 8gent-OS once the contract is stable.
 */
import { parseArgs, provisionTenant, summarize } from "./provision-tenant/index.ts";

async function main(): Promise<number> {
	let opts;
	try {
		opts = parseArgs(process.argv.slice(2));
	} catch (e) {
		console.error((e as Error).message);
		return 2;
	}

	try {
		const { plan, minutePath } = await provisionTenant(opts);
		console.log("");
		console.log(summarize(plan));
		console.log(`minute: ${minutePath}`);
		const errors = plan.steps.filter((s) => s.status === "error");
		return errors.length > 0 ? 1 : 0;
	} catch (e) {
		console.error(`provision-tenant failed: ${(e as Error).message}`);
		return 1;
	}
}

if (import.meta.main) {
	process.exit(await main());
}
