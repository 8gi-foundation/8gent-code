/**
 * System One harness guard: an extra layer on the agent's shell tools.
 *
 * Flag: env EIGHT_SYSTEM_ONE. ON by default. Three modes (`systemOneMode`):
 *   unset / anything else -> "default": on, and it never blocks everything.
 *                            When the judge cannot answer (no judge model
 *                            installed, backend unreachable, invalid answer,
 *                            timeout) it falls back to the deterministic rule
 *                            pre-filter alone and says so once.
 *   1 / true              -> "strict": the explicit opt-in. Fails closed as
 *                            before: a judge that cannot answer blocks.
 *   0 / false / off / no  -> "off": `systemOneGate` returns { run: true }
 *                            without importing @8gent/decide or constructing a
 *                            decider, so the shell path is unchanged.
 * Under `bun test` (NODE_ENV=test) an unset flag means off, so unrelated
 * tests never load a judge; tests that pass an env without NODE_ENV get the
 * real default.
 *
 * With the flag on, every model-proposed shell command is sent to
 * `bashGuard` (packages/decide/guard.ts) AFTER the existing layers (ToolG8 /
 * policy engine, PermissionManager, shell sanitiser) have passed it and
 * BEFORE it is spawned. It can only take a command away, never give one back:
 * a command an earlier layer denied never reaches this function.
 *
 *   allow    -> run
 *   block    -> not run; the tool returns a [SYSTEM ONE BLOCKED] error. The
 *               first block in a process (default mode) also carries a
 *               one-line notice naming the opt-out, EIGHT_SYSTEM_ONE=0.
 *   escalate -> ask a human through the TUI approval channel, else an
 *               interactive stdin prompt (default No); no human available
 *               (headless, daemon, CI) -> treated as block
 *   error    -> strict: block (fail closed). default: rule pre-filter only
 *               (block rule -> block, escalate rule -> escalate, no rule ->
 *               run), with a one-time notice. Covers decider missing,
 *               backend unreachable, invalid probability, anything that throws.
 *   timeout  -> same split as error: no verdict within the time budget
 *               (30 s until the first answer, then 10 s; env
 *               EIGHT_SYSTEM_ONE_TIMEOUT_MS overrides). The escalate prompt
 *               to a human is outside the budget. If the judge is still
 *               loading (warm-up in flight) when the budget runs out, the
 *               message says so and asks to retry in a few seconds.
 *
 * Notices go to the sink set by `setSystemOneNoticeSink` (the TUI registers
 * its system-message channel), else to stderr. Each notice is shown once per
 * process.
 *
 * Warm-up: `startSystemOneWarmup` (called at TUI and Agent startup) builds the
 * decider and asks the judge one throwaway question in the background, so the
 * model load does not land on the user's first command. A gate call that
 * arrives during warm-up waits for it inside its own budget. Flag off: it
 * returns null and imports nothing. Measured cost on an M-series Mac with the
 * Selene-1 8B Q4_K_M GGUF (in-process llamacpp): about 4.4 s and about 5.6 GB
 * of resident memory, then about 0.24 s per gated command.
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

export type SystemOneMode = "off" | "default" | "strict";

/** The mode for this env; see the header. On by default, 0 turns it off, 1 is strict. */
export function systemOneMode(env: Record<string, string | undefined> = process.env): SystemOneMode {
	const v = (env[SYSTEM_ONE_FLAG] ?? "").trim().toLowerCase();
	if (v === "1" || v === "true") return "strict";
	if (v === "0" || v === "false" || v === "off" || v === "no") return "off";
	if (v === "" && env.NODE_ENV === "test") return "off";
	return "default";
}

export function systemOneEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return systemOneMode(env) !== "off";
}

/** One line, shown once per process with the first block in default mode. */
export const SYSTEM_ONE_FIRST_BLOCK_NOTICE = `System One blocked a shell command. It is on by default; set ${SYSTEM_ONE_FLAG}=0 to turn it off.`;

/** Shown once per process when default mode falls back to the rule pre-filter. */
export function systemOneFallbackNotice(reason: string): string {
	return `System One judge unavailable (${reason}); checking shell commands with the rule pre-filter only. Set ${SYSTEM_ONE_FLAG}=0 to turn System One off.`;
}

type NoticeSink = (line: string) => void;
let noticeSink: NoticeSink | null = null;
const noticesShown = new Set<string>();

/** Where one-time notices go (the TUI passes its system-message channel). null: stderr. */
export function setSystemOneNoticeSink(sink: NoticeSink | null): void {
	noticeSink = sink;
}

/** Emit `line` once per process under `key`. Returns true when it was emitted now. */
function noticeOnce(key: string, line: string): boolean {
	if (noticesShown.has(key)) return false;
	noticesShown.add(key);
	try {
		if (noticeSink) noticeSink(line);
		else process.stderr.write(`${line}\n`);
	} catch {
		// A broken sink must never affect the gate.
	}
	return true;
}

export type SystemOneThresholds = "default" | "rules-only" | `calibrated(${string})`;

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
	noticesShown.clear();
	noticeSink = null;
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
	return g.backend !== "unavailable" && g.backend !== "rule" && g.backend !== "rules" && g.backend !== RULES_ONLY;
}

/** Backend label of a verdict made by the rule pre-filter alone (default-mode fallback). */
export const RULES_ONLY = "rules-only" as const;

/** True when the judge did not produce a usable answer (not a rule or prompt-control verdict). */
function judgeFailed(g: BashGuardResult): boolean {
	if (g.backend === "unavailable") return true;
	return isModelVerdict(g) && !Number.isFinite(g.pYes);
}

/**
 * The default-mode fallback: prompt-control, then the deterministic rules,
 * with no model. Rules never allow on their own, so "pass" runs the command.
 */
async function rulesOnlyGuard(command: string, why: string): Promise<BashGuardResult> {
	const { promptControlText } = await import("../decide/guard");
	const { decideRules } = await import("../decide/rules");
	const control = promptControlText(command);
	if (control !== null) {
		return {
			verdict: "block",
			pYes: Number.NaN,
			backend: "rule",
			model: "prompt-control",
			reason: `the command carries prompt-control text addressed to the judge (${JSON.stringify(control)})`,
		};
	}
	const r = decideRules(command);
	const base = { pYes: Number.NaN, backend: RULES_ONLY, model: "none" };
	if (r.verdict === "block") {
		return {
			...base,
			verdict: "block",
			pYes: 1,
			rule: r.rule,
			reason: `deterministic rule ${r.rule} matched (${r.rules.join(", ")}); judge unavailable (${why})`,
		};
	}
	if (r.verdict === "escalate") {
		return {
			...base,
			verdict: "escalate",
			rule: r.rule,
			reason: `deterministic rule ${r.rule} matched (${r.rules.join(", ")}), needs a human; judge unavailable (${why})`,
		};
	}
	return { ...base, verdict: "allow", reason: `no rule matched; judge unavailable (${why})` };
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
	return `${SYSTEM_ONE_BLOCK_MARKER} ${fields}. Blocked by System One (${SYSTEM_ONE_FLAG} on; ${SYSTEM_ONE_FLAG}=0 turns it off): ${why}. The command was not run. Command: ${command}`;
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
	const mode = systemOneMode(env);
	if (mode === "off") return { run: true };
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
		const detail = (err as Error)?.message ?? String(err);
		const why =
			err instanceof SystemOneTimeoutError
				? warmupLoading
					? `the System One judge is still loading (warm-up in progress, not ready within ${ms} ms), failing closed; retry in a few seconds`
					: `System One ${detail}`
				: `System One unavailable, failing closed: ${detail}`;
		if (mode === "default") {
			const reason = err instanceof SystemOneTimeoutError ? `no verdict within ${ms} ms` : detail;
			return decide(command, await fallback(command, reason), RULES_ONLY);
		}
		guard = { verdict: "block", pYes: Number.NaN, backend: "unavailable", model: "unavailable" };
		return { run: false, guard, message: blockMessage(guard, thresholds, why, command) };
	}
	if (isModelVerdict(guard)) warmed = true;
	if (mode === "default" && judgeFailed(guard)) {
		return decide(command, await fallback(command, guard.reason ?? "the judge gave no valid answer"), RULES_ONLY);
	}
	return decide(command, guard, thresholds as SystemOneThresholds, mode);
}

/** Rule-only verdict plus the one-time fallback notice. */
async function fallback(command: string, reason: string): Promise<BashGuardResult> {
	noticeOnce("fallback", systemOneFallbackNotice(reason));
	return rulesOnlyGuard(command, reason);
}

/** Turn a verdict into run / block, asking a human on escalate. */
async function decide(
	command: string,
	guard: BashGuardResult,
	label: SystemOneThresholds,
	mode: SystemOneMode = "default",
): Promise<SystemOneGateResult> {
	const blocked = (why: string, extra: Partial<SystemOneGateResult> = {}): SystemOneGateResult => {
		let message = blockMessage(guard, label, why, command);
		if (mode === "default" && noticeOnce("first-block", SYSTEM_ONE_FIRST_BLOCK_NOTICE)) {
			message = `${message}\n${SYSTEM_ONE_FIRST_BLOCK_NOTICE}`;
		}
		return { run: false, guard, thresholds: label, message, ...extra };
	};
	if (guard.verdict === "allow") return { run: true, guard, thresholds: label };
	if (guard.verdict === "block") return blocked(guard.reason ?? "the command was judged dangerous");
	// escalate
	let humanApproved: boolean | null;
	const pDesc = Number.isFinite(guard.pYes) ? `pYes ${fmtP(guard.pYes)}, ` : "";
	try {
		humanApproved = await (overrides.askHuman ?? defaultAskHuman)({
			action: "System One escalation",
			details: guard.rule
				? `A System One safety rule (${guard.rule}) matched this command (${pDesc}${guard.backend}/${guard.model}). Approve only if you meant it.`
				: `System One is unsure whether this command is safe (${pDesc}${guard.backend}/${guard.model}). Approve only if you meant it.`,
			command,
		});
	} catch {
		humanApproved = null;
	}
	if (humanApproved === true) return { run: true, guard, thresholds: label, humanApproved };
	const why =
		humanApproved === false
			? "escalated and the user declined"
			: "escalated but no approval channel is available, so escalate is treated as block";
	return blocked(why, { humanApproved });
}
