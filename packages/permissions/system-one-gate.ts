/**
 * System One harness guard: an extra, opt-in layer on the agent's shell tools.
 *
 * Flag: env EIGHT_SYSTEM_ONE=1 (or "true"). OFF by default. With the flag off
 * `systemOneGate` returns { run: true } without importing @8gent/decide or
 * constructing a decider, so the shell path is unchanged.
 *
 * With the flag on, every model-proposed shell command is sent to
 * `bashGuard` (packages/decide/guard.ts) AFTER the existing layers (ToolG8 /
 * policy engine, PermissionManager, shell sanitiser) have passed it and
 * BEFORE it is spawned. It can only take a command away, never give one back:
 * a command an earlier layer denied never reaches this function.
 *
 *   allow    -> run
 *   block    -> not run; the tool returns a [SYSTEM ONE BLOCKED] error
 *   escalate -> ask a human through the TUI approval channel, else an
 *               interactive stdin prompt (default No); no human available
 *               (headless, daemon, CI) -> treated as block
 *   error    -> block (fail closed): decider missing, backend unreachable,
 *               invalid probability, or anything else that throws
 *   timeout  -> block (fail closed): no verdict within the time budget
 *               (30 s until the first answer, then 10 s; env
 *               EIGHT_SYSTEM_ONE_TIMEOUT_MS overrides). The escalate prompt
 *               to a human is outside the budget. If the judge is still
 *               loading (warm-up in flight) when the budget runs out, the
 *               message says so and asks to retry in a few seconds.
 *
 * Warm-up: `startSystemOneWarmup` (called at TUI and Agent startup) builds the
 * decider and asks the judge one throwaway question in the background, so the
 * model load does not land on the user's first command. A gate call that
 * arrives during warm-up waits for it inside its own budget. Flag off: it
 * returns null and imports nothing.
 *
 * Escalate deliberately does NOT go through PermissionManager.requestPermission:
 * that method auto-approves in infinite mode, with autoApprove, for allow-listed
 * commands and for any non-dangerous command when headless. System One escalates
 * exactly the commands those rules consider harmless, so routing through it would
 * silently turn "escalate" into "allow".
 *
 * bashGuard runs the deterministic rule pre-filter (packages/decide/rules.ts)
 * before the model: a block rule blocks without asking (backend "rules"), an
 * escalate rule escalates unless the model blocks.
 *
 * One decider per process (createDecider, auto backend). Thresholds come from
 * calibration/<backend>-<model>.json for the detected (backend, model) via
 * loadCalibration + toRawGuardOptions, else bashGuard's defaults.
 *
 * Wired into (see packages/decide/README.md "Harness guard"):
 *   - packages/eight/tools.ts  ToolExecutor.runCommand, handleBackgroundStart,
 *                              handleSpawnAgent (runtime "shell")
 *   - packages/ai/tools.ts     runShellCommand, background_start,
 *                              spawn_agent (runtime "shell")
 */

import * as readline from "node:readline";
import type { BashGuardOptions, BashGuardResult } from "../decide/guard";
import type { Decider } from "../decide/index";
import { requestTuiApproval } from "./tui-approval-channel";

export const SYSTEM_ONE_FLAG = "EIGHT_SYSTEM_ONE";
export const SYSTEM_ONE_BLOCK_MARKER = "[SYSTEM ONE BLOCKED]";
/** Env override for the per-call time budget, in ms. */
export const SYSTEM_ONE_TIMEOUT_ENV = "EIGHT_SYSTEM_ONE_TIMEOUT_MS";
/** Budget once the decider has answered once in this process. */
export const DEFAULT_TIMEOUT_MS = 10_000;
/**
 * Budget before the first answer, which includes the model load: the first
 * gate call took 5.9 to 6.7 s here with the GGUF in the disk cache, and a first
 * ever llamacpp run took 47 s. A load that overruns blocks that one command;
 * the load carries on and the next call uses it.
 */
export const DEFAULT_COLD_TIMEOUT_MS = 30_000;

/**
 * Time budget for one gate call (decider construction, calibration lookup and
 * the guard question). Env EIGHT_SYSTEM_ONE_TIMEOUT_MS (a positive number)
 * wins, else 30 s until the decider has answered once, then 10 s.
 */
export function systemOneTimeoutMs(env: Record<string, string | undefined> = process.env): number {
	const raw = Number((env[SYSTEM_ONE_TIMEOUT_ENV] ?? "").trim());
	if (Number.isFinite(raw) && raw > 0) return raw;
	return warmed ? DEFAULT_TIMEOUT_MS : DEFAULT_COLD_TIMEOUT_MS;
}

class SystemOneTimeoutError extends Error {}

/** Reject after `ms`. The losing promise settles on its own (race keeps its rejection handled); the command never waits for it. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new SystemOneTimeoutError(`timed out after ${ms} ms, failing closed`)), ms);
	});
	return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

export function systemOneEnabled(env: Record<string, string | undefined> = process.env): boolean {
	const v = (env[SYSTEM_ONE_FLAG] || "").trim().toLowerCase();
	return v === "1" || v === "true";
}

export type SystemOneThresholds = "default" | `calibrated(${string})`;

export interface SystemOneGateResult {
	run: boolean;
	/** Tool error text when run is false. */
	message?: string;
	/** The guard verdict, absent only when the flag is off. */
	guard?: BashGuardResult;
	thresholds?: SystemOneThresholds;
	/** Set when the verdict was escalate: true approved, false declined, null no human. */
	humanApproved?: boolean | null;
}

/** Ask a human. true approve, false decline, null when no human can be asked. */
export type AskHuman = (request: { action: string; details: string; command: string }) => Promise<
	boolean | null
>;

interface Overrides {
	createDecider?: () => Decider | Promise<Decider>;
	askHuman?: AskHuman;
	calibrationDir?: string;
}

let overrides: Overrides = {};
let deciderPromise: Promise<Decider> | null = null;
/** True once the decider has returned a verdict in this process (switches to the warm timeout). */
let warmed = false;
/** The in-flight or finished background warm-up, null when none was started (or it failed). */
let warmupPromise: Promise<void> | null = null;
/** True while the warm-up is running (the judge is still loading). */
let warmupLoading = false;
/** Bumped on test reset so a stale warm-up from an earlier test cannot touch the new state. */
let generation = 0;
const thresholdCache = new Map<string, { opts: BashGuardOptions; label: SystemOneThresholds }>();

/** Test-only: inject a decider factory / human prompt and drop the process decider. */
export function _setSystemOneOverridesForTests(next: Overrides): void {
	overrides = next;
	deciderPromise = null;
	warmed = false;
	warmupPromise = null;
	warmupLoading = false;
	generation++;
	thresholdCache.clear();
}

/** Test-only: forget the process decider and any overrides. */
export function _resetSystemOne(): void {
	_setSystemOneOverridesForTests({});
}

function getDecider(): Promise<Decider> {
	if (!deciderPromise) {
		deciderPromise = (async () => {
			if (overrides.createDecider) return overrides.createDecider();
			const { createDecider } = await import("../decide/index");
			return createDecider();
		})();
		// A failed construction (e.g. the module failed to load) must not stick.
		deciderPromise.catch(() => {
			deciderPromise = null;
		});
	}
	return deciderPromise;
}

async function thresholdsFor(
	decider: Decider,
): Promise<{ opts: BashGuardOptions; label: SystemOneThresholds }> {
	const backend = await decider.backend();
	const key = JSON.stringify([backend.name, backend.model]);
	const hit = thresholdCache.get(key);
	if (hit) return hit;
	const { loadCalibration, toRawGuardOptions } = await import("../decide/calibrate");
	const cal = overrides.calibrationDir
		? loadCalibration(backend.model, backend.name, overrides.calibrationDir)
		: loadCalibration(backend.model, backend.name);
	const entry = cal
		? {
				opts: toRawGuardOptions(cal),
				label: `calibrated(${backend.name}, ${backend.model})` as SystemOneThresholds,
			}
		: { opts: {}, label: "default" as SystemOneThresholds };
	thresholdCache.set(key, entry);
	return entry;
}

function isModelVerdict(g: BashGuardResult): boolean {
	return g.backend !== "unavailable" && g.backend !== "rule" && g.backend !== "rules";
}

/** The command the warm-up asks about. Harmless and never run. */
export const SYSTEM_ONE_WARMUP_COMMAND = "echo warmup";

/**
 * Start loading the judge in the background: build the decider, look up its
 * thresholds and ask one throwaway question, so the model load happens before
 * the user's first command instead of inside it. Idempotent: returns the same
 * promise while it runs or after it succeeded. Flag off: returns null without
 * importing @8gent/decide. The promise rejects if the load fails; a failed
 * warm-up does not stick (the next gate call retries construction).
 */
export function startSystemOneWarmup(
	env: Record<string, string | undefined> = process.env,
): Promise<void> | null {
	if (!systemOneEnabled(env)) return null;
	if (warmupPromise) return warmupPromise;
	const gen = generation;
	warmupLoading = true;
	const p = (async () => {
		const decider = await getDecider();
		const t = await thresholdsFor(decider);
		const { bashGuard } = await import("../decide/guard");
		const g = await bashGuard(SYSTEM_ONE_WARMUP_COMMAND, decider, t.opts);
		if (gen === generation && isModelVerdict(g)) warmed = true;
	})();
	warmupPromise = p;
	p.then(
		() => {
			if (gen === generation) warmupLoading = false;
		},
		() => {
			if (gen !== generation) return;
			warmupLoading = false;
			warmupPromise = null;
		},
	);
	return p;
}

function fmtP(p: number): string {
	return Number.isFinite(p) ? p.toFixed(4) : "NaN";
}

function blockMessage(
	g: BashGuardResult,
	thresholds: SystemOneThresholds | "unknown",
	why: string,
	command: string,
): string {
	const fields = `verdict=${g.verdict} pYes=${fmtP(g.pYes)} backend=${g.backend} model=${g.model} thresholds=${thresholds}`;
	return `${SYSTEM_ONE_BLOCK_MARKER} ${fields}. Blocked by System One (${SYSTEM_ONE_FLAG}=1): ${why}. The command was not run. Command: ${command}`;
}

/** TUI approval card if a frontend registered one, else an interactive stdin prompt (default No), else null. */
export const defaultAskHuman: AskHuman = async (request) => {
	const tui = await requestTuiApproval(request);
	if (tui !== null) return tui;
	if (!process.stdin.isTTY || process.env.EIGHT_HEADLESS) return null;
	return new Promise((resolve) => {
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
		const prompt = `\n\x1b[33m[SYSTEM ONE ESCALATION]\x1b[0m\n${request.details}\nCommand: \x1b[36m${request.command}\x1b[0m\n\nRun it? [y/N]: `;
		rl.question(prompt, (answer) => {
			rl.close();
			const a = answer.trim().toLowerCase();
			resolve(a === "y" || a === "yes");
		});
	});
};

/**
 * Decide whether a shell command may run. Call only after every existing
 * layer has allowed it. Never throws.
 */
export async function systemOneGate(
	command: string,
	env: Record<string, string | undefined> = process.env,
): Promise<SystemOneGateResult> {
	if (!systemOneEnabled(env)) return { run: true };
	let guard: BashGuardResult;
	let thresholds: SystemOneThresholds | "unknown" = "unknown";
	const ms = systemOneTimeoutMs(env);
	// A warm-up in flight owns the model load; wait for it inside this budget.
	const warmup = warmupLoading ? warmupPromise : null;
	try {
		guard = await withTimeout(
			(async () => {
				if (warmup) await warmup.catch(() => {});
				const decider = await getDecider();
				const t = await thresholdsFor(decider);
				thresholds = t.label;
				const { bashGuard } = await import("../decide/guard");
				return bashGuard(command, decider, t.opts);
			})(),
			ms,
		);
	} catch (err) {
		guard = { verdict: "block", pYes: Number.NaN, backend: "unavailable", model: "unavailable" };
		const detail = (err as Error)?.message ?? String(err);
		const why =
			err instanceof SystemOneTimeoutError
				? warmupLoading
					? `the System One judge is still loading (warm-up in progress, not ready within ${ms} ms), failing closed; retry in a few seconds`
					: `System One ${detail}`
				: `System One unavailable, failing closed: ${detail}`;
		return { run: false, guard, message: blockMessage(guard, thresholds, why, command) };
	}
	if (isModelVerdict(guard)) warmed = true;
	const t = thresholds as SystemOneThresholds;
	if (guard.verdict === "allow") return { run: true, guard, thresholds: t };
	if (guard.verdict === "block") {
		const why = guard.reason ?? "the command was judged dangerous";
		return { run: false, guard, thresholds: t, message: blockMessage(guard, t, why, command) };
	}
	// escalate
	let humanApproved: boolean | null;
	try {
		humanApproved = await (overrides.askHuman ?? defaultAskHuman)({
			action: "System One escalation",
			details: guard.rule
				? `A System One safety rule (${guard.rule}) matched this command (pYes ${fmtP(guard.pYes)}, ${guard.backend}/${guard.model}). Approve only if you meant it.`
				: `System One is unsure whether this command is safe (pYes ${fmtP(guard.pYes)}, ${guard.backend}/${guard.model}). Approve only if you meant it.`,
			command,
		});
	} catch {
		humanApproved = null;
	}
	if (humanApproved === true) return { run: true, guard, thresholds: t, humanApproved };
	const why =
		humanApproved === false
			? "escalated and the user declined"
			: "escalated but no approval channel is available, so escalate is treated as block";
	return {
		run: false,
		guard,
		thresholds: t,
		humanApproved,
		message: blockMessage(guard, t, why, command),
	};
}
