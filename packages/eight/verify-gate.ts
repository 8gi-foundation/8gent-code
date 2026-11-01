/**
 * 8gent - Verify-before-done gate (issue #3550).
 *
 * Law 1 (honesty.ts) checks that a completion claim has a successful action
 * behind it. It does not check that the result was looked at. This gate adds
 * that step: when a turn changed files and nothing checked them afterwards,
 * the agent gets one message asking it to run the most targeted check (a test,
 * a command, or a read of the file) before it answers.
 *
 *   - Off by default. On with EIGHT_VERIFY_GATE=1 (or "true").
 *   - At most one nudge per turn; the caller enforces that.
 *   - A turn with no successful write, edit or delete never gets a nudge.
 *   - A successful read_file, run_command or git_diff AFTER the last change
 *     counts as the check. One that ran before the change does not.
 *
 * Pure functions, no I/O. The caller (packages/eight/agent.ts) owns the
 * turn's tool ledger and wires the nudge into both the native and the
 * text-tool loop.
 */

/** Tool calls that change files on disk. */
export const CHANGE_TOOLS: ReadonlySet<string> = new Set([
	"write_file",
	"edit_file",
	"delete_file",
]);

/** Tool calls that count as checking a change. */
export const VERIFY_TOOLS: ReadonlySet<string> = new Set(["read_file", "run_command", "git_diff"]);

/** The message sent once when a turn changed files and checked nothing after. */
export const VERIFY_NUDGE_MESSAGE = [
	"You changed files this turn but have not checked the result since the last change.",
	"Before you answer, verify it with the most targeted check you have: run the",
	"relevant test or command, or read back the file you changed.",
	"Then reply with your final summary, including what the check showed,",
	'starting with "DONE:". If the check fails, fix it first.',
].join("\n");

/** Minimal ledger shape the gate reads (matches honesty.ts ToolLedgerEntry). */
export interface VerifyLedgerEntry {
	name: string;
	success: boolean;
}

/** True when EIGHT_VERIFY_GATE is set to "1" or "true". Default off. */
export function isVerifyGateEnabled(
	env: Record<string, string | undefined> = process.env,
): boolean {
	const v = (env.EIGHT_VERIFY_GATE ?? "").trim().toLowerCase();
	return v === "1" || v === "true";
}

/**
 * Does this turn need a verification step before it may answer? True when a
 * change tool succeeded and no verify tool succeeded after the last one.
 */
export function needsVerification(ledger: readonly VerifyLedgerEntry[]): boolean {
	let lastChange = -1;
	for (let i = 0; i < ledger.length; i++) {
		if (ledger[i].success && CHANGE_TOOLS.has(ledger[i].name)) lastChange = i;
	}
	if (lastChange < 0) return false;
	for (let i = lastChange + 1; i < ledger.length; i++) {
		if (ledger[i].success && VERIFY_TOOLS.has(ledger[i].name)) return false;
	}
	return true;
}

/**
 * The nudge to send for this ledger, or null. Null whenever the gate is off,
 * so callers can wire it unconditionally.
 */
export function verifyNudgeFor(
	ledger: readonly VerifyLedgerEntry[],
	env: Record<string, string | undefined> = process.env,
): string | null {
	if (!isVerifyGateEnabled(env)) return null;
	return needsVerification(ledger) ? VERIFY_NUDGE_MESSAGE : null;
}
