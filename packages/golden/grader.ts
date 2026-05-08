/**
 * Golden grader.
 *
 * Pure, deterministic, no LLM. Each check yields a CheckOutcome; the
 * case passes only when every check passes. The score is the fraction
 * of checks that passed - useful for tracking partial regressions over
 * time even when the case is failing overall.
 */

import type {
	AgentRunResult,
	CheckOutcome,
	GoldenCase,
	GradeResult,
	RegexCheck,
	SubstringCheck,
	ToolCallCheck,
} from "./schema";

function gradeSubstring(output: string, check: SubstringCheck): CheckOutcome {
	const haystack = check.caseSensitive ? output : output.toLowerCase();
	const needle = check.caseSensitive ? check.value : check.value.toLowerCase();
	const found = haystack.includes(needle);
	if (check.mode === "missing") {
		return {
			name: `substring missing "${check.value}"`,
			passed: !found,
			detail: found ? "expected absent, found present" : undefined,
		};
	}
	return {
		name: `substring present "${check.value}"`,
		passed: found,
		detail: found ? undefined : "expected present, found absent",
	};
}

function gradeRegex(output: string, check: RegexCheck): CheckOutcome {
	let re: RegExp;
	try {
		re = new RegExp(check.pattern, check.flags ?? "");
	} catch (err) {
		return {
			name: `regex /${check.pattern}/`,
			passed: false,
			detail: `invalid pattern: ${(err as Error).message}`,
		};
	}
	const found = re.test(output);
	if (check.mode === "missing") {
		return {
			name: `regex missing /${check.pattern}/`,
			passed: !found,
			detail: found ? "expected absent, found present" : undefined,
		};
	}
	return {
		name: `regex present /${check.pattern}/`,
		passed: found,
		detail: found ? undefined : "no match",
	};
}

function gradeTools(calls: AgentRunResult["toolCalls"], check: ToolCallCheck): CheckOutcome[] {
	const outcomes: CheckOutcome[] = [];
	const names = new Set(calls.map((c) => c.tool));
	for (const required of check.required) {
		outcomes.push({
			name: `tool required "${required}"`,
			passed: names.has(required),
			detail: names.has(required) ? undefined : "tool not invoked",
		});
	}
	for (const forbidden of check.forbidden) {
		outcomes.push({
			name: `tool forbidden "${forbidden}"`,
			passed: !names.has(forbidden),
			detail: names.has(forbidden) ? "tool was invoked" : undefined,
		});
	}
	if (check.minCalls !== undefined) {
		outcomes.push({
			name: `tool calls >= ${check.minCalls}`,
			passed: calls.length >= check.minCalls,
			detail: `got ${calls.length}`,
		});
	}
	if (check.maxCalls !== undefined) {
		outcomes.push({
			name: `tool calls <= ${check.maxCalls}`,
			passed: calls.length <= check.maxCalls,
			detail: `got ${calls.length}`,
		});
	}
	return outcomes;
}

function gradeLatency(durationMs: number, wallMs: number): CheckOutcome {
	return {
		name: `latency <= ${wallMs}ms`,
		passed: durationMs <= wallMs,
		detail: `actual ${durationMs}ms`,
	};
}

function gradeLength(output: string, min?: number, max?: number): CheckOutcome[] {
	const outcomes: CheckOutcome[] = [];
	if (min !== undefined) {
		outcomes.push({
			name: `length >= ${min}`,
			passed: output.length >= min,
			detail: `actual ${output.length}`,
		});
	}
	if (max !== undefined) {
		outcomes.push({
			name: `length <= ${max}`,
			passed: output.length <= max,
			detail: `actual ${output.length}`,
		});
	}
	return outcomes;
}

export function grade(run: AgentRunResult, gcase: GoldenCase): GradeResult {
	const checks: CheckOutcome[] = [];

	// Hard error: an exception during the run fails everything regardless
	// of substring presence (e.g. a stack trace might happen to include
	// expected words).
	if (run.error) {
		checks.push({
			name: "no transport error",
			passed: false,
			detail: run.error,
		});
		return {
			caseId: gcase.id,
			passed: false,
			score: 0,
			checks,
		};
	}

	for (const sub of gcase.expect.substrings) {
		checks.push(gradeSubstring(run.response, sub));
	}
	for (const re of gcase.expect.regexes) {
		checks.push(gradeRegex(run.response, re));
	}
	if (gcase.expect.tools) {
		checks.push(...gradeTools(run.toolCalls, gcase.expect.tools));
	}
	if (gcase.expect.latency) {
		checks.push(gradeLatency(run.durationMs, gcase.expect.latency.wallMs));
	}
	checks.push(...gradeLength(run.response, gcase.expect.minLength, gcase.expect.maxLength));

	if (checks.length === 0) {
		// No checks declared - the case is degenerate. Treat as a fail
		// so authors notice and add real expectations rather than a
		// silent pass.
		checks.push({
			name: "case has at least one check",
			passed: false,
			detail: "no expectations defined",
		});
	}

	const passedCount = checks.filter((c) => c.passed).length;
	const score = passedCount / checks.length;
	return {
		caseId: gcase.id,
		passed: passedCount === checks.length,
		score,
		checks,
	};
}
