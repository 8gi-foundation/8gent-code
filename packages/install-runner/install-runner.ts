/**
 * @8gent/install-runner — install-runner.ts
 *
 * Interactive install path for /spawn presets. Runs the preset's
 * install command with full stdio inheritance (real PTY, real
 * prompts, real colors) so the user can answer setup wizards,
 * accept terms, complete OAuth flows, etc. Pairs with the
 * non-interactive auto-installer in apps/tui/src/lib/external-agent-runner.ts:
 *   - `runInstall` (this file) → run from the user's shell, full UX
 *   - auto-installer in /spawn → silent, fast, no prompts, suppressed output
 *
 * The CLI subcommand `8gent install <preset>` is the user-facing
 * entry point; see `bin/8gent.ts` for that wiring.
 */

import { spawn } from "node:child_process";

// Minimal preset shape we need — kept loose so we don't import the
// full type from apps/tui (cross-layer dep). The CLI subcommand
// resolves the real preset and passes it in as plain data.
export interface InstallPreset {
	id: string;
	label: string;
	command: string;
	install?: { command: string; notes?: string };
	homepage?: string;
}

// ============================================================================
// Plan (pure)
// ============================================================================

export interface InstallRunPlan {
	canRun: boolean;
	/** Shell command to execute, or null if no recipe is configured. */
	command: string | null;
	/** Human-readable hint shown after install, or directing the user
	 * to a manual path when canRun is false. */
	notes: string;
}

export function planInstallRun(args: { preset: InstallPreset }): InstallRunPlan {
	const { preset } = args;
	if (preset.install?.command) {
		return {
			canRun: true,
			command: preset.install.command,
			notes:
				preset.install.notes ??
				`Run \`${preset.command}\` once after install to verify it works.`,
		};
	}
	return {
		canRun: false,
		command: null,
		notes: preset.homepage
			? `${preset.id} has no auto-install recipe configured. See ${preset.homepage} for install steps.`
			: `${preset.id} has no auto-install recipe configured.`,
	};
}

export function formatInstallHeader(args: {
	preset: InstallPreset;
	command: string;
}): string {
	const { preset, command } = args;
	return `\n=== Installing ${preset.label} (\`${preset.command}\`) ===\n  $ ${command}\n`;
}

// ============================================================================
// Runner (impure — spawns a shell)
// ============================================================================

export interface InstallRunResult {
	action: "ran" | "dry-run" | "no-recipe";
	command: string | null;
	exitCode: number | null;
}

export interface RunInstallOpts {
	preset: InstallPreset;
	/** When true, plan only — print or return the would-be command. */
	dryRun?: boolean;
	/** Override stdio for tests so we don't spam the test runner output. */
	stdio?: "inherit" | "ignore" | "pipe";
}

export async function runInstall(opts: RunInstallOpts): Promise<InstallRunResult> {
	const plan = planInstallRun({ preset: opts.preset });
	if (!plan.canRun || !plan.command) {
		return { action: "no-recipe", command: null, exitCode: null };
	}
	if (opts.dryRun) {
		return { action: "dry-run", command: plan.command, exitCode: null };
	}

	const cmd = plan.command;
	const stdio = opts.stdio ?? "inherit";

	return new Promise((resolve) => {
		const proc = spawn("bash", ["-lc", cmd], { stdio });
		proc.on("error", () => {
			resolve({ action: "ran", command: cmd, exitCode: null });
		});
		proc.on("close", (code) => {
			resolve({ action: "ran", command: cmd, exitCode: code });
		});
	});
}
