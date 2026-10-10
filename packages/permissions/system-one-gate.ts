/**
 * System One harness guard: an extra layer on the agent's shell tools.
 *
 * Flag: env EIGHT_SYSTEM_ONE. ON by default (James, 2026-09-30). Three modes
 * (`systemOneMode`):
 *   unset / anything else -> "default": on, and it never blocks everything.
 *                            It asks only a calibrated judge (a model with a
 *                            calibration/<backend>-<model>.json). When there is
 *                            none, or the judge cannot answer (not installed,
 *                            unreachable, invalid answer, timeout), commands are
 *                            checked by the deterministic rules and the
 *                            read-only allowlist alone, and it says so once.
 *   1 / true              -> "strict": the explicit opt-in. Any judge the
 *                            probe finds is asked. When it cannot answer, the
 *                            rules still run (a block rule is final) and
 *                            everything else goes to a person through the
 *                            card, never an allow (#3193); with no person
 *                            (headless, pilot) that is a block, fail closed.
 *                            Guarded mode (#3170) sets this.
 *   0 / false / off / no  -> "off": `systemOneGate` returns { run: true }
 *                            without importing @8gent/decide or constructing a
 *                            decider, so the shell path is unchanged.
 *
 * With the flag on, every model-proposed shell command is sent to
 * `bashGuard` (packages/decide/guard.ts) after the deny layers (ToolG8 /
 * policy engine, the permission deny list, shell sanitiser) have passed it,
 * BEFORE the permission approval card, and before it is spawned. It can only
 * take a command away, never give one back: a command an earlier layer denied
 * never reaches this function.
 *
 * Why before the card (#3124): a block is final, so it must never follow a Y
 * the person was asked for; and an escalate asks the person itself, so that
 * one answer is the card. Callers skip the permission card when
 * `humanApproved === true`: one command, one card.
 *
 *   allow    -> run
 *   block    -> not run; the tool returns a [SYSTEM ONE BLOCKED] error
 *   escalate -> ask a human through the TUI approval channel, else an
 *               interactive stdin prompt (default No); no human available
 *               (headless, daemon, CI) -> treated as block
 *   error    -> strict: rules, then a person decides; headless: block
 *               (fail closed). default: rules only (block
 *               rule -> block, escalate rule -> escalate, no rule -> run),
 *               with a one-time notice. Covers decider missing, backend
 *               unreachable, invalid probability, anything that throws.
 *   timeout  -> same split as error: no verdict within the time budget
 *               (30 s until the first answer, then 10 s; env
 *               EIGHT_SYSTEM_ONE_TIMEOUT_MS overrides). The escalate prompt
 *               to a human is outside the budget. If the judge is still
 *               loading (warm-up in flight) when the budget runs out, the
 *               message says so and asks to retry in a few seconds.
 *
 * Notices (one line each, once per process) go to the sink set by
 * `setSystemOneNoticeSink` (the TUI passes its system-message channel), else
 * to stderr: that there is no judge and why, and, before the first judge
 * load, which model loads where and how big it is.
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
import type { CreatedFiles } from "./s1-created-files";
import { hasTuiApprovalHandler, requestTuiApproval } from "./tui-approval-channel";

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
		timer = setTimeout(
			() => reject(new SystemOneTimeoutError(`timed out after ${ms} ms, failing closed`)),
			ms,
		);
	});
	return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

export type SystemOneMode = "off" | "default" | "strict";

/** The mode for this env; see the header. On by default, 0 turns it off, 1 is strict. */
export function systemOneMode(
	env: Record<string, string | undefined> = process.env,
): SystemOneMode {
	const v = (env[SYSTEM_ONE_FLAG] ?? "").trim().toLowerCase();
	if (v === "1" || v === "true") return "strict";
	if (v === "0" || v === "false" || v === "off" || v === "no") return "off";
	return "default";
}

export function systemOneEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return systemOneMode(env) !== "off";
}

/** Shown once per process when default mode checks with the rules and allowlist alone. */
export function systemOneRulesOnlyNotice(reason: string): string {
	return `System One: no judge (${reason}); shell commands are checked by the safety rules and the read-only allowlist only. ${SYSTEM_ONE_FLAG}=0 turns System One off.`;
}

/** Shown once per process when strict mode (Guarded, EIGHT_SYSTEM_ONE=1) has no checker and asks the person instead. */
export const SYSTEM_ONE_ASK_INSTEAD_NOTICE =
	"Safety check: the full checker isn't available, so you will be asked before each command it would have checked.";

/** Shown once per process before the first judge load, so a multi-GB load is never silent. */
export function systemOneJudgeLoadNotice(
	model: string,
	where: string,
	bytes: number | null,
): string {
	const size = bytes && bytes > 0 ? `, ${(bytes / 1e9).toFixed(1)} GB` : "";
	return `System One: loading the judge ${model} (${where}${size}) for a command the allowlist does not cover. ${SYSTEM_ONE_FLAG}=0 turns System One off.`;
}

type NoticeSink = (line: string) => void;
let noticeSink: NoticeSink | null = null;
const noticesShown = new Set<string>();

/** Where one-time notices go (the TUI passes its system-message channel). null: stderr. */
export function setSystemOneNoticeSink(sink: NoticeSink | null): void {
	noticeSink = sink;
}

/** Emit `line` once per process under `key`. */
function noticeOnce(key: string, line: string): void {
	if (noticesShown.has(key)) return;
	noticesShown.add(key);
	try {
		if (noticeSink) noticeSink(line);
		else process.stderr.write(`${line}\n`);
	} catch {
		// A broken sink must never affect the gate.
	}
}

/**
 * Rules-first allowlist (packages/decide/allowlist.ts, #3131). ON by default
 * whenever System One is on (James, 2026-09-30); EIGHT_S1_ALLOWLIST=0 (or
 * false/off/no) opts out. With EIGHT_SYSTEM_ONE=0, none of this runs.
 *
 * With it on, a command the rules pass and the allowlist reads as plainly
 * read-only runs without asking the model judge (backend "allowlist"), and
 * the judge is no longer warmed at startup: it loads on the first command
 * that needs it, inside the cold budget. The rules always run first and win.
 *
 * Also under this flag (#3168): an `rm` whose every target does not exist
 * inside the caller's working directory passes without the judge, since it
 * deletes nothing; and (#3177) so does one whose targets are absent or
 * untracked files this session created, per the caller's CreatedFiles record
 * (see s1-rm-nothing.ts and s1-created-files.ts for the exact conditions);
 * and (#3669) so does `rm [-f] <file>` / `unlink <file>` of exactly one
 * untracked scratch-style regular file inside the workspace (under run/,
 * tmp/ or .cache/, or named *.lock / *.pid), such as a stale lock whose
 * owner is dead (see s1-rm-single.ts). When that last rule says no but the
 * command was close, its plain-words hint is appended to a block message so
 * a block is not a dead end.
 *
 * `bun test` runs the repo's own test code, so skipping the judge for it is a
 * trust call: EIGHT_S1_ALLOWLIST_BUN_TEST=1 opts in, and it is OFF by default.
 */
export const SYSTEM_ONE_ALLOWLIST_FLAG = "EIGHT_S1_ALLOWLIST";
export const SYSTEM_ONE_ALLOWLIST_BUN_TEST_FLAG = "EIGHT_S1_ALLOWLIST_BUN_TEST";

function flagValue(env: Record<string, string | undefined>, name: string): string {
	return (env[name] || "").trim().toLowerCase();
}

export function systemOneAllowlist(env: Record<string, string | undefined> = process.env): {
	enabled: boolean;
	bunTest: boolean;
} {
	const enabled = !["0", "false", "off", "no"].includes(flagValue(env, SYSTEM_ONE_ALLOWLIST_FLAG));
	const bun = flagValue(env, SYSTEM_ONE_ALLOWLIST_BUN_TEST_FLAG);
	return { enabled, bunTest: enabled && (bun === "1" || bun === "true") };
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

/** Backend label of a verdict made by the rules alone (default-mode fallback). */
export const RULES_ONLY = "rules-only" as const;

function isModelVerdict(g: BashGuardResult): boolean {
	return (
		g.backend !== "unavailable" &&
		g.backend !== "rule" &&
		g.backend !== "rules" &&
		g.backend !== "allowlist" &&
		g.backend !== RULES_ONLY
	);
}

/** True when the judge did not really answer: it threw, or gave no usable probability. Rule verdicts are not failures. */
function judgeFailed(g: BashGuardResult): boolean {
	if (g.backend === "unavailable") return true;
	return isModelVerdict(g) && !Number.isFinite(g.pYes);
}

/** Thrown in default mode when the judge the probe found has no calibration: it is never asked. */
class UncalibratedJudgeError extends Error {}

/**
 * Default mode asks only a judge whose (backend, model) was calibrated. The
 * probe falls back to the smallest installed model, which on a machine with
 * no judge is the chat model: uncalibrated, it would judge at guessed
 * thresholds (and escalate most commands). Strict mode keeps asking it.
 */
function requireCalibrated(
	mode: SystemOneMode,
	backend: { name: string; model: string },
	label: SystemOneThresholds,
): void {
	if (mode === "default" && label === "default") {
		throw new UncalibratedJudgeError(
			`${backend.model} on ${backend.name} has no calibration, so it is not used as the judge`,
		);
	}
}

/** Name the judge load once, with its size when the GGUF is on disk. Best effort, never throws. */
async function announceJudgeLoad(
	decider: Decider,
	env: Record<string, string | undefined>,
): Promise<void> {
	if (warmed || noticesShown.has("load")) return;
	try {
		const b = (await decider.backend()) as { name: string; model: string; modelPath?: string };
		const where = b.name === "llamacpp" ? "in this process" : `in the ${b.name} server`;
		let bytes: number | null = null;
		try {
			const fs = await import("node:fs");
			let file = b.modelPath ?? null;
			if (!file) {
				const { resolveGguf } = await import("../decide/backends/llamacpp");
				file = resolveGguf(env, b.model).path;
			}
			if (file) bytes = fs.statSync(file).size;
		} catch {
			bytes = null;
		}
		noticeOnce("load", systemOneJudgeLoadNotice(b.model, where, bytes));
	} catch {
		// No notice is better than a broken gate.
	}
}

/**
 * The default-mode fallback: prompt-control, then the deterministic rules,
 * with no model. Rules never allow on their own, so "pass" runs the command
 * (the allowlist has already run).
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
			rule: r.rule,
			reason: `deterministic rule ${r.rule} matched (${r.rules.join(", ")}); no judge (${why})`,
		};
	}
	if (r.verdict === "escalate") {
		return {
			...base,
			verdict: "escalate",
			rule: r.rule,
			reason: `deterministic rule ${r.rule} matched (${r.rules.join(", ")}), needs a human; no judge (${why})`,
		};
	}
	return { ...base, verdict: "allow", reason: `no rule matched; no judge (${why})` };
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
	const mode = systemOneMode(env);
	if (mode === "off") return null;
	// Allowlist on: most commands never reach the judge, so load it lazily.
	if (systemOneAllowlist(env).enabled) return null;
	if (warmupPromise) return warmupPromise;
	const gen = generation;
	warmupLoading = true;
	const p = (async () => {
		const decider = await getDecider();
		const t = await thresholdsFor(decider);
		requireCalibrated(mode, await decider.backend(), t.label);
		await announceJudgeLoad(decider, env);
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

/**
 * True once the judge has given a real model verdict (warm-up or a gate
 * call). The TUI footer reads it to clear "judge failed" after a later gate
 * call loaded the judge: a failed warm-up does not stick, so neither may its
 * status.
 */
export function systemOneJudgeWarm(): boolean {
	return warmed;
}

function fmtP(p: number): string {
	return Number.isFinite(p) ? p.toFixed(4) : "NaN";
}

/** In every refusal, so the model stops instead of retrying the same command (#3193). */
export const SYSTEM_ONE_NO_RETRY =
	"Do not run this command again: it will be refused the same way. Use a different approach, or tell the user what you need.";

function blockMessage(
	g: BashGuardResult,
	thresholds: SystemOneThresholds | "unknown",
	why: string,
	command: string,
	hint?: string,
): string {
	const fields = `verdict=${g.verdict} pYes=${fmtP(g.pYes)} backend=${g.backend} model=${g.model} thresholds=${thresholds}`;
	// A block is final: no card was shown and no approval can pass it. Say so,
	// so the reply never tells the person their approval is what is missing (#3124).
	const final =
		g.verdict === "block" ? " No approval can run it: a System One block is final." : "";
	// Plain words on why the single-file delete rule did not take it, and what
	// it does allow (#3669), so the block is not a dead end.
	const help = hint ? ` ${hint}` : "";
	return `${SYSTEM_ONE_BLOCK_MARKER} ${fields}. Blocked by System One (on; ${SYSTEM_ONE_FLAG}=0 turns it off): ${why}. The command was not run.${final}${help} ${SYSTEM_ONE_NO_RETRY} Command: ${command}`;
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
	cwd?: string,
	created?: CreatedFiles,
): Promise<SystemOneGateResult> {
	const mode = systemOneMode(env);
	if (mode === "off") return { run: true };
	const allow = systemOneAllowlist(env);
	/** Plain words for the block message when the single-file rule nearly matched (#3669). */
	let hint: string | undefined;
	if (allow.enabled) {
		try {
			const { readOnlyAllowlist } = await import("../decide/allowlist");
			const a = readOnlyAllowlist(command, { bunTest: allow.bunTest });
			if (a.verdict === "pass-without-model") {
				return {
					run: true,
					guard: {
						verdict: "allow",
						pYes: Number.NaN,
						backend: "allowlist",
						model: "allowlist",
						reason: a.reason,
					},
				};
			}
		} catch {
			// The allowlist failing is "no opinion": fall through to the judge.
		}
		// An rm whose every target is absent inside the workspace deletes
		// nothing (#3168); one whose targets are absent or untracked files this
		// session created removes only its own scratch (#3177); an absent
		// absolute path under a real temp root also deletes nothing (#3381).
		// Needs the caller's working directory (and record); without them,
		// today's behaviour.
		try {
			const { rmOfNothingOrOwn } = await import("./s1-rm-nothing");
			const kind = rmOfNothingOrOwn(command, cwd, created);
			if (kind) {
				return {
					run: true,
					guard: {
						verdict: "allow",
						pYes: Number.NaN,
						backend: "allowlist",
						model: "allowlist",
						reason:
							kind === "nothing"
								? "rm of paths that do not exist in the workspace: nothing to delete"
								: kind === "nothing-temp"
									? "rm of paths that do not exist (absolute ones under a real temp root): nothing to delete"
									: "rm of untracked files this session created (or of absent paths): its own scratch",
					},
				};
			}
		} catch {
			// No opinion: fall through to the judge.
		}
		// One untracked scratch-style file that existed before the session,
		// such as a stale lock whose owner process is dead (#3669). Exactly one
		// named regular file inside the workspace; see s1-rm-single.ts.
		try {
			const { singleFileDelete } = await import("./s1-rm-single");
			const single = singleFileDelete(command, cwd);
			if (single.ok) {
				return {
					run: true,
					guard: {
						verdict: "allow",
						pYes: Number.NaN,
						backend: "allowlist",
						model: "allowlist",
						reason: `rm of one untracked scratch file inside the workspace (${single.rel})`,
					},
				};
			}
			hint = single.hint;
		} catch {
			// No opinion: fall through to the judge.
		}
		// A plain `mv` whose every endpoint is inside the workspace and that
		// overwrites nothing (#3809). Needs the caller's working directory.
		try {
			const { moveInProject } = await import("./s1-mv-in-project");
			const mv = moveInProject(command, cwd);
			if (mv.ok) {
				return {
					run: true,
					guard: {
						verdict: "allow",
						pYes: Number.NaN,
						backend: "allowlist",
						model: "allowlist",
						reason: mv.reason,
					},
				};
			}
		} catch {
			// No opinion: fall through to the judge.
		}
		// `git clone <local repo> <new dir inside the workspace>` (#3826).
		try {
			const { cloneLocalIntoProject } = await import("./s1-clone-local");
			const clone = cloneLocalIntoProject(command, cwd);
			if (clone.ok) {
				return {
					run: true,
					guard: {
						verdict: "allow",
						pYes: Number.NaN,
						backend: "allowlist",
						model: "allowlist",
						reason: clone.reason,
					},
				};
			}
		} catch {
			// No opinion: fall through to the judge.
		}
	}
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
				requireCalibrated(mode, await decider.backend(), t.label);
				await announceJudgeLoad(decider, env);
				const { bashGuard } = await import("../decide/guard");
				return bashGuard(command, decider, t.opts);
			})(),
			ms,
		);
	} catch (err) {
		const detail = (err as Error)?.message ?? String(err);
		if (mode === "default") {
			const reason =
				err instanceof SystemOneTimeoutError
					? `the judge gave no verdict within ${ms} ms${warmupLoading ? " (still loading)" : ""}`
					: detail;
			return decide(command, await rulesOnly(command, reason), RULES_ONLY, hint);
		}
		// Strict (EIGHT_SYSTEM_ONE=1, Guarded): the checker cannot answer, so
		// a person decides through the normal card, never an allow (#3193).
		// With no person (headless, pilot) that escalate is a block: fail closed.
		const reason =
			err instanceof SystemOneTimeoutError
				? `the checker timed out after ${ms} ms${warmupLoading ? " while still loading" : ""}`
				: `System One unavailable: ${detail}`;
		return decide(command, await askInstead(command, reason), RULES_ONLY, hint);
	}
	if (isModelVerdict(guard)) warmed = true;
	if (judgeFailed(guard)) {
		const reason = guard.reason ?? "the judge gave no valid answer";
		return decide(
			command,
			mode === "default" ? await rulesOnly(command, reason) : await askInstead(command, reason),
			RULES_ONLY,
			hint,
		);
	}
	return decide(command, guard, thresholds as SystemOneThresholds, hint);
}

/** True when a person can be asked: a TUI approval channel, or an interactive terminal. */
function personCanBeAsked(): boolean {
	return hasTuiApprovalHandler() || (!!process.stdin.isTTY && !process.env.EIGHT_HEADLESS);
}

/**
 * Strict mode without a checker: the rules still run first, and a block rule
 * is still final. Everything else goes to a person as an escalate, never an
 * allow. One plain line says so, once, when there is a person to ask.
 */
async function askInstead(command: string, reason: string): Promise<BashGuardResult> {
	if (personCanBeAsked()) noticeOnce("ask-instead", SYSTEM_ONE_ASK_INSTEAD_NOTICE);
	const g = await rulesOnlyGuard(command, reason);
	if (g.verdict !== "allow") return g;
	return {
		...g,
		verdict: "escalate",
		reason: `the safety checker is not available (${reason}), so a person decides`,
	};
}

/** The notice's short form of why there is no judge; the full reason stays on the verdict. */
function noticeReason(reason: string): string {
	if (reason.startsWith("no decide backend available"))
		return "no judge model installed or reachable";
	return reason.length > 120 ? `${reason.slice(0, 117)}...` : reason;
}

/** Rules-only verdict plus the one-time notice that says so. */
async function rulesOnly(command: string, reason: string): Promise<BashGuardResult> {
	noticeOnce("rules-only", systemOneRulesOnlyNotice(noticeReason(reason)));
	return rulesOnlyGuard(command, reason);
}

/** Turn a verdict into run / block, asking a human on escalate. */
async function decide(
	command: string,
	guard: BashGuardResult,
	t: SystemOneThresholds,
	hint?: string,
): Promise<SystemOneGateResult> {
	if (guard.verdict === "allow") return { run: true, guard, thresholds: t };
	if (guard.verdict === "block") {
		const why = guard.reason ?? "the command was judged dangerous";
		return {
			run: false,
			guard,
			thresholds: t,
			message: blockMessage(guard, t, why, command, hint),
		};
	}
	// escalate
	const pDesc = Number.isFinite(guard.pYes) ? `pYes ${fmtP(guard.pYes)}, ` : "";
	let humanApproved: boolean | null;
	try {
		humanApproved = await (overrides.askHuman ?? defaultAskHuman)({
			action: "System One escalation",
			details: guard.rule
				? `A System One safety rule (${guard.rule}) matched this command (${pDesc}${guard.backend}/${guard.model}). Approve only if you meant it.`
				: guard.backend === RULES_ONLY
					? "The full safety checker isn't available, so you decide whether this runs. Approve only if you meant it."
					: `System One is unsure whether this command is safe (${pDesc}${guard.backend}/${guard.model}). Approve only if you meant it.`,
			command,
		});
	} catch {
		humanApproved = null;
	}
	if (humanApproved === true) return { run: true, guard, thresholds: t, humanApproved };
	const base =
		humanApproved === false
			? "escalated and the user declined"
			: "escalated but no approval channel is available, so escalate is treated as block, failing closed";
	const why = guard.backend === RULES_ONLY && guard.reason ? `${base} (${guard.reason})` : base;
	return {
		run: false,
		guard,
		thresholds: t,
		humanApproved,
		message: blockMessage(guard, t, why, command, hint),
	};
}
