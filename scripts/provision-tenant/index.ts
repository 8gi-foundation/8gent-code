import { clerkAdapter } from "./clerk.ts";
import { convexAdapter } from "./convex.ts";
import { dnsAdapter } from "./dns.ts";
import { validateHandle } from "./handle.ts";
import { buildMinuteInput, writeMinute } from "./minute.ts";
import { secretsAdapter } from "./secrets.ts";
import { storageAdapter } from "./storage.ts";
/**
 * Orchestrator for Wave 4 B-2 tenant provisioning.
 *
 * Sequence: dns -> clerk -> convex -> secrets -> storage -> minute.
 * Each adapter is independently idempotent. The orchestrator collects PlanSteps
 * and writes a boardroom minute draft regardless of dry-run state.
 *
 * CLI usage:
 *   bun run scripts/provision-tenant.ts --handle james           # dry-run
 *   bun run scripts/provision-tenant.ts --handle james --apply   # mutate live infra
 */
import type { Adapter, Ctx, ProvisionOptions, ProvisionPlan } from "./types.ts";

export const ADAPTERS: Adapter[] = [
	dnsAdapter,
	clerkAdapter,
	convexAdapter,
	secretsAdapter,
	storageAdapter,
];

export interface ProvisionResult {
	plan: ProvisionPlan;
	minutePath: string;
}

export async function provisionTenant(
	opts: ProvisionOptions,
	ctxIn?: Partial<Ctx>,
): Promise<ProvisionResult> {
	const handle = validateHandle(opts.handle);
	const startedAt = (ctxIn?.now ? ctxIn.now() : new Date()).toISOString();

	const ctx: Ctx = {
		rootDir: opts.rootDir,
		env: ctxIn?.env ?? process.env,
		fetch: ctxIn?.fetch ?? globalThis.fetch.bind(globalThis),
		now: ctxIn?.now ?? (() => new Date()),
		logger: ctxIn?.logger ?? consoleLogger(),
		apply: opts.apply,
	};

	ctx.logger.info(`provision-tenant: handle="${handle}", apply=${opts.apply}`);

	const steps = [];
	for (const adapter of ADAPTERS) {
		ctx.logger.info(`> ${adapter.name}`);
		const step = await adapter.plan(handle, ctx);
		ctx.logger.info(
			`  ${step.status}: ${step.detail}${step.error ? ` (error: ${step.error})` : ""}`,
		);
		steps.push(step);
	}

	const finishedAt = ctx.now().toISOString();
	const plan: ProvisionPlan = { handle, dryRun: !opts.apply, steps, startedAt, finishedAt };
	const minutePath = await writeMinute(ctx, buildMinuteInput(handle, plan, ctx.env));
	ctx.logger.info(`minute written: ${minutePath}`);

	return { plan, minutePath };
}

export function parseArgs(argv: string[]): ProvisionOptions {
	let handle: string | undefined;
	let apply = false;
	const remaining: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--handle") {
			handle = argv[++i];
		} else if (a?.startsWith("--handle=")) {
			handle = a.slice("--handle=".length);
		} else if (a === "--apply") {
			apply = true;
		} else if (a === "--help" || a === "-h") {
			handle = "__help__";
		} else if (a) {
			remaining.push(a);
		}
	}
	if (!handle && remaining.length === 1) {
		handle = remaining[0];
	}
	if (!handle) {
		throw new Error(
			"Missing --handle. Usage: bun run scripts/provision-tenant.ts --handle <name> [--apply]",
		);
	}
	if (handle === "__help__") {
		throw new Error("Usage: bun run scripts/provision-tenant.ts --handle <name> [--apply]");
	}
	return { handle, apply, rootDir: process.cwd() };
}

function consoleLogger(): Ctx["logger"] {
	return {
		info: (msg) => console.log(msg),
		warn: (msg) => console.warn(msg),
		error: (msg) => console.error(msg),
	};
}

export function summarize(plan: ProvisionPlan): string {
	const counts: Record<string, number> = {};
	for (const s of plan.steps) counts[s.status] = (counts[s.status] ?? 0) + 1;
	const parts = Object.entries(counts).map(([k, v]) => `${k}=${v}`);
	return `tenant=${plan.handle} mode=${plan.dryRun ? "dry-run" : "apply"} ${parts.join(" ")}`;
}
