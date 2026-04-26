/**
 * Shared types for the tenant provisioning script (Wave 4 B-2).
 * Adapters mutate or read one resource each. Everything is mockable via Ctx.
 */

export type ResourceStatus = "create" | "exists" | "rotate" | "skip" | "error";

export interface PlanStep {
	resource: string;
	status: ResourceStatus;
	detail: string;
	error?: string;
}

export interface ProvisionPlan {
	handle: string;
	dryRun: boolean;
	steps: PlanStep[];
	startedAt: string;
	finishedAt: string;
}

export interface ProvisionOptions {
	handle: string;
	apply: boolean;
	rootDir: string;
}

export interface Ctx {
	rootDir: string;
	env: Record<string, string | undefined>;
	fetch: typeof fetch;
	now(): Date;
	logger: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
	apply: boolean;
}

export interface Adapter {
	name: string;
	plan(handle: string, ctx: Ctx): Promise<PlanStep>;
}

export interface MinuteInput {
	handle: string;
	plan: ProvisionPlan;
	chair: string;
	officers: string[];
}
