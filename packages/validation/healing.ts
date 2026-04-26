/**
 * 8gent Code - Self-Healing Executor
 *
 * Hypothesis Loop pattern: checkpoint -> action -> verify -> revert-if-fail.
 * Inspired by atomic commit-verify-revert for self-healing agents.
 *
 * Usage:
 *   const healer = new SelfHealer({ cwd: process.cwd() });
 *   const result = await healer.healingLoop(
 *     async () => { await runMyRiskyThing(); },
 *     [{ name: "tests", command: "bun test" }]
 *   );
 */

import { spawnSync } from "child_process";
import {
	type Checkpoint,
	createCheckpoint,
	dropCheckpoint,
	restoreCheckpoint,
} from "./checkpoint";
import { type FailureEntry, findPriorFailure, logFailure } from "./failure-log";

// ============================================
// Types
// ============================================

export interface VerifyCheck {
	name: string;
	command: string; // e.g. "bun test", "bun run build"
	expectExitCode?: number; // default 0
	timeoutMs?: number; // default 60_000
}

export interface VerifyResult {
	passed: boolean;
	checks: Array<{
		name: string;
		ok: boolean;
		output: string;
		exitCode: number;
	}>;
}

export interface HealingResult {
	success: boolean;
	attempts: number;
	checkpointId: string;
	failureLog: FailureEntry[];
}

export interface SelfHealerOptions {
	cwd?: string;
	maxAttempts?: number; // default 3 (mirrors config self-heal.maxRetries)
}

// ============================================
// SelfHealer
// ============================================

export class SelfHealer {
	private cwd: string;
	private maxAttempts: number;

	constructor(opts: SelfHealerOptions = {}) {
		this.cwd = opts.cwd ?? process.cwd();
		this.maxAttempts = opts.maxAttempts ?? 3;
	}

	/**
	 * Create a checkpoint before making changes.
	 * Returns a checkpoint ID.
	 */
	checkpoint(label = "healing-checkpoint"): Checkpoint {
		return createCheckpoint(this.cwd, label);
	}

	/**
	 * Run all verification checks.
	 */
	verify(checks: VerifyCheck[]): VerifyResult {
		const results = checks.map((check) => {
			const r = spawnSync("sh", ["-c", check.command], {
				cwd: this.cwd,
				encoding: "utf-8",
				timeout: check.timeoutMs ?? 60_000,
			});

			const exitCode = r.status ?? 1;
			const expected = check.expectExitCode ?? 0;
			const output = ((r.stdout ?? "") + (r.stderr ?? "")).trim();

			return {
				name: check.name,
				ok: exitCode === expected,
				output: output.slice(0, 400), // cap output for log
				exitCode,
			};
		});

		return {
			passed: results.every((r) => r.ok),
			checks: results,
		};
	}

	/**
	 * Revert to a checkpoint.
	 */
	revert(cp: Checkpoint): void {
		restoreCheckpoint(this.cwd, cp);
	}

	/**
	 * Hypothesis Loop: checkpoint -> action -> verify -> revert-if-fail.
	 *
	 * On each failed attempt, reverts to checkpoint and retries.
	 * Logs all failures to ~/.8gent/healing/failures.jsonl.
	 */
	async healingLoop(
		action: () => Promise<void>,
		checks: VerifyCheck[],
		maxAttempts?: number,
		actionLabel = "agent-action",
	): Promise<HealingResult> {
		const limit = maxAttempts ?? this.maxAttempts;
		const failureLog: FailureEntry[] = [];

		// Warn if we've seen this fail before
		const prior = findPriorFailure(actionLabel);
		if (prior) {
			console.warn(
				`[heal] Prior failure for "${actionLabel}" on ${prior.timestamp}: ${prior.error}`,
			);
		}

		// Create checkpoint once — reuse across all attempts
		const cp = this.checkpoint(actionLabel);

		for (let attempt = 1; attempt <= limit; attempt++) {
			try {
				await action();
			} catch (err) {
				const error = err instanceof Error ? err.message : String(err);
				const entry: FailureEntry = {
					timestamp: new Date().toISOString(),
					action: actionLabel,
					error,
					resolution:
						attempt < limit ? `retrying (attempt ${attempt})` : "reverted",
					checkpointId: cp.id,
					attempts: attempt,
				};
				failureLog.push(entry);
				logFailure(entry);

				if (attempt < limit) {
					this.revert(cp);
					continue;
				}

				// Final attempt failed during action — revert and bail
				this.revert(cp);
				return {
					success: false,
					attempts: attempt,
					checkpointId: cp.id,
					failureLog,
				};
			}

			// Action completed — verify
			const result = this.verify(checks);

			if (result.passed) {
				dropCheckpoint(this.cwd, cp);
				return {
					success: true,
					attempts: attempt,
					checkpointId: cp.id,
					failureLog,
				};
			}

			// Verification failed
			const failedChecks = result.checks.filter((c) => !c.ok);
			const error = failedChecks
				.map((c) => `${c.name}: exit ${c.exitCode} — ${c.output.slice(0, 120)}`)
				.join(" | ");

			const entry: FailureEntry = {
				timestamp: new Date().toISOString(),
				action: actionLabel,
				error,
				resolution:
					attempt < limit ? `retrying (attempt ${attempt})` : "reverted",
				checkpointId: cp.id,
				attempts: attempt,
			};
			failureLog.push(entry);
			logFailure(entry);

			this.revert(cp);

			if (attempt === limit) {
				return {
					success: false,
					attempts: attempt,
					checkpointId: cp.id,
					failureLog,
				};
			}
		}

		// Should not reach here, but satisfy TypeScript
		return { success: false, attempts: limit, checkpointId: cp.id, failureLog };
	}
}
