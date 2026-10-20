/**
 * 8gent - Test-claim done gate (issue #4505).
 *
 * Evidence run 2026-10-20_084256 (sigi-dev-aider-js-a): the model wrote bowling.js at
 * 07:49Z, its last test run (07:47Z) exited 1, and it then reported "All 30 tests pass".
 * The judge found 5 failing. The honesty gate (#2747) only checks that SOME action
 * succeeded; the verify gate (#3550) counts a read_file as a check. Neither compares the
 * last test run with the last write.
 *
 * This gate does. A turn-ending reply that claims tests pass is refused unless the turn's
 * most recent test command (a) ran after the most recent file change and (b) succeeded.
 * Ledger order is the clock: an entry later in the ledger is newer, and unlike a wall
 * timestamp it cannot tie. First violation: one user-role line, one more turn. Second:
 * the caller ends the task with done_gate "stale_or_failing_tests".
 *
 *   - Off by default. On with EIGHT_TEST_CLAIM_GATE=1 (or "true") or the testClaimGate: true option.
 *   - Pure functions, no I/O. agent.ts owns the ledger and the one-nudge counter.
 *   - Not the project check in done-gate.ts (`8gent run`, on by default, EIGHT_DONE_GATE=0
 *     turns that off). This gate never reads EIGHT_DONE_GATE. That one runs the project's tests itself; this one audits a claim.
 */

import { CHANGE_TOOLS } from "./verify-gate";

export const DONE_GATE_FIELD = "stale_or_failing_tests";

export const TEST_CLAIM_NUDGE =
	"The last test run was before your last edit (or exited non-zero). Run the tests, then finish.";

/** Ledger shape this gate reads (a subset of honesty.ts ToolLedgerEntry). */
export interface TestGateEntry {
	name: string;
	args?: Record<string, unknown>;
	success: boolean;
	result?: string;
}

// Claim forms, per sentence. Plural "tests" or "test suite" only, so "The test passed the
// validator" is not a claim; no bare "all pass" ("all pass through the proxy").
const PASS = "(?:pass(?:es|ed|ing)?|green)";
const CLAIM_FORMS = [
	new RegExp(
		`\\b(?:all\\s+)?(?:\\d+\\s+)?(?:unit\\s+|the\\s+)?tests\\s+(?:(?:are|were|now|all|still)\\s+)*${PASS}\\b`,
		"i",
	),
	new RegExp(`\\btest\\s+suites?\\s+(?:(?:are|were|now|all|still)\\s+)*${PASS}\\b`, "i"),
	/\b\d+\s+(?:tests?\s+)?passed\b(?!\s+(?:the|through|to|by|into|on|in|from|a|an)\b)/i,
];
// Words that make a sentence an instruction, a plan or a condition, not a report.
const NOT_A_REPORT =
	/\b(?:make\s+sure|ensure|until|so\s+that|should|will|if|whether|must|need\s+to)\b/i;
// "0 failed", "no failures", "zero errors" are clean; any other fail or error word is not.
const ZERO_FAIL = /\b(?:0|no|zero)\s+(?:tests?\s+)?(?:fail\w*|errors?)\b/gi;
const FAIL_WORD = /\b(?:fail\w*|errors?)\b/i;

/** True when one sentence reports passing tests: a claim form, no instruction word before it, no non-zero fail count. */
function sentenceClaims(sentence: string): boolean {
	if (FAIL_WORD.test(sentence.replace(ZERO_FAIL, ""))) return false;
	return CLAIM_FORMS.some((re) => {
		const m = re.exec(sentence);
		return m !== null && !NOT_A_REPORT.test(sentence.slice(0, m.index));
	});
}

// A test command at the start of a shell segment, so `echo "bun test"` does not count.
const TEST_CMD =
	/(?:^|[;&|]\s*|&&\s*)(?:cd\s+\S+\s*&&\s*)?(?:(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?test|(?:python3?\s+-m\s+)?pytest|cargo\s+test|go\s+test|(?:npx\s+|bunx\s+)?(?:vitest|jest))\b/;

export function isDoneGateEnabled(
	env: Record<string, string | undefined> = process.env,
	option?: boolean,
): boolean {
	if (option !== undefined) return option;
	const v = (env.EIGHT_TEST_CLAIM_GATE ?? "").trim().toLowerCase();
	return v === "1" || v === "true";
}

export function claimsTestsPass(reply: string): boolean {
	return reply.split(/(?<=[.!?])\s+|\n+/).some(sentenceClaims);
}

function isTestRun(e: TestGateEntry): boolean {
	return (
		e.name === "run_command" && typeof e.args?.command === "string" && TEST_CMD.test(e.args.command)
	);
}

/** A test run passed only if the tool succeeded AND its output carries no non-zero exit. */
function testPassed(e: TestGateEntry): boolean {
	return e.success && !/^Exit code (?!0\b)/.test(e.result ?? "");
}

/**
 * True when the reply claims passing tests and the ledger does not back it: no test run
 * after the last successful change, or the last test run failed. A turn that never wrote
 * and never ran a test is the honesty gate's business, not this one's.
 */
export function testClaimViolation(ledger: readonly TestGateEntry[], reply: string): boolean {
	if (!claimsTestsPass(reply)) return false;
	let lastWrite = -1;
	let lastTest = -1;
	for (let i = 0; i < ledger.length; i++) {
		const e = ledger[i];
		if (e.success && CHANGE_TOOLS.has(e.name)) lastWrite = i;
		if (isTestRun(e)) lastTest = i;
	}
	if (lastTest < 0) return lastWrite >= 0;
	return lastTest < lastWrite || !testPassed(ledger[lastTest]);
}
