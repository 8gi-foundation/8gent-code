/**
 * Writes a boardroom minute draft for a tenant provisioning. The draft lands
 * in this repo at docs/boardroom-minutes-drafts/. A human PRs it into
 * 8gi-governance/docs/boardroom-minutes/ later. This is the
 * "no cross-repo push" rule from the B-2 scope agreement.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Ctx, MinuteInput, ProvisionPlan } from "./types.ts";

export function minutePath(rootDir: string, handle: string, now: Date): string {
	const date = now.toISOString().slice(0, 10);
	return join(rootDir, "docs", "boardroom-minutes-drafts", `${date}-tenant-${handle}.md`);
}

export function renderMinute(input: MinuteInput): string {
	const { handle, plan, chair, officers } = input;
	const lines: string[] = [];
	lines.push(`# Tenant Provisioning Minute - ${handle}`);
	lines.push("");
	lines.push("**Wave:** 4");
	lines.push("**Track:** B-2 (Tenant Provisioning)");
	lines.push(`**Status:** ${plan.dryRun ? "DRAFT (dry-run)" : "DRAFT (applied)"}`);
	lines.push(`**Chair:** ${chair}`);
	lines.push(`**Officers consulted:** ${officers.join(", ")}`);
	lines.push(`**Started:** ${plan.startedAt}`);
	lines.push(`**Finished:** ${plan.finishedAt}`);
	lines.push("");
	lines.push("## Resources");
	lines.push("");
	lines.push("| Resource | Status | Detail |");
	lines.push("|----------|--------|--------|");
	for (const step of plan.steps) {
		const detail = step.error ? `${step.detail} (error: ${step.error})` : step.detail;
		lines.push(`| ${esc(step.resource)} | ${step.status} | ${esc(detail)} |`);
	}
	lines.push("");
	lines.push("## Notes");
	lines.push("");
	if (plan.dryRun) {
		lines.push(
			"- Dry-run only. No live infrastructure was mutated. Re-run with `--apply` to provision.",
		);
	} else {
		const errors = plan.steps.filter((s) => s.status === "error");
		if (errors.length > 0) {
			lines.push(`- ${errors.length} adapter(s) reported errors. Review before promoting tenant.`);
		} else {
			lines.push(
				"- All adapters reported success or pre-existing resource. Tenant is ready for B-3 dogfood.",
			);
		}
	}
	lines.push("");
	lines.push("## Next steps");
	lines.push("");
	lines.push(
		`- Human PRs this minute into \`8gi-foundation/8gi-governance\` at \`docs/boardroom-minutes/${plan.finishedAt.slice(0, 10)}-tenant-${handle}.md\`.`,
	);
	lines.push("- B-7 mints the BotFather token and replaces the placeholder slot file.");
	lines.push("- B-5 attribution telemetry begins tagging events with the new tenantId.");
	lines.push("");
	return lines.join("\n");
}

export async function writeMinute(ctx: Ctx, input: MinuteInput): Promise<string> {
	const path = minutePath(ctx.rootDir, input.handle, ctx.now());
	await mkdir(join(ctx.rootDir, "docs", "boardroom-minutes-drafts"), { recursive: true });
	await writeFile(path, renderMinute(input), "utf8");
	return path;
}

function esc(value: string): string {
	return value.replace(/\|/g, "\\|");
}

export function buildMinuteInput(
	handle: string,
	plan: ProvisionPlan,
	env: Record<string, string | undefined>,
): MinuteInput {
	return {
		handle,
		plan,
		chair: env.BOARD_CHAIR ?? "James Spalding",
		officers: ["8TO Rishi", "8SO Karen", "8GO Solomon"],
	};
}
