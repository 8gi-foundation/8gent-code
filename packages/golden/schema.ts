/**
 * Golden test schema.
 *
 * A golden test is a deterministic prompt run against the agent with
 * expected signals: what should appear in the output, which tools may
 * or must be called, and what wall-clock budget the run is allowed.
 *
 * Cases are authored as JSON files in `cases/` and validated against
 * this Zod schema at load time. Anything that drifts from the schema
 * is a hard error - we want strict, machine-checkable goldens, not
 * a hand-eye-rubric that rots quietly.
 */

import { z } from "zod";

/**
 * Substring expectation. The output is checked case-insensitively
 * unless `caseSensitive` is set. Use `mode: "missing"` to assert that
 * a string MUST NOT appear (useful for catching regressions where the
 * agent leaks scaffolding tokens, internal IDs, or refuses to answer).
 */
export const SubstringCheck = z.object({
	value: z.string().min(1),
	mode: z.enum(["present", "missing"]).default("present"),
	caseSensitive: z.boolean().default(false),
});

export const RegexCheck = z.object({
	pattern: z.string().min(1),
	flags: z.string().optional(),
	mode: z.enum(["present", "missing"]).default("present"),
});

/**
 * Tool-call expectations.
 * - `required`: every tool name listed must appear in the captured tool calls
 * - `forbidden`: none of the listed tool names may appear
 * - `minCalls`/`maxCalls`: bounds on the total number of tool invocations
 */
export const ToolCallCheck = z.object({
	required: z.array(z.string()).default([]),
	forbidden: z.array(z.string()).default([]),
	minCalls: z.number().int().min(0).optional(),
	maxCalls: z.number().int().min(0).optional(),
});

/**
 * Latency budget. `wallMs` bounds end-to-end response time; `firstTokenMs`
 * is reserved for streaming runs and currently advisory.
 */
export const LatencyBudget = z.object({
	wallMs: z.number().int().positive(),
	firstTokenMs: z.number().int().positive().optional(),
});

export const GoldenCase = z.object({
	/** Stable id - used as the key in result diffs across runs. */
	id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, {
		message: "id must be lowercase kebab-case",
	}),
	/** Short human-readable title for reports. */
	title: z.string().min(1),
	/** Free-text categorisation - "reasoning", "tool-use", "refusal" etc. */
	tags: z.array(z.string()).default([]),
	/** Optional channel hint for the daemon AgentPool. Defaults to "api". */
	channel: z.string().default("api"),
	/** The prompt sent to agent.chat(). */
	prompt: z.string().min(1),
	/** Deterministic checks. All must pass for the case to score 1.0. */
	expect: z.object({
		substrings: z.array(SubstringCheck).default([]),
		regexes: z.array(RegexCheck).default([]),
		tools: ToolCallCheck.optional(),
		latency: LatencyBudget.optional(),
		/** Minimum non-empty output length, in characters. */
		minLength: z.number().int().min(0).optional(),
		/** Maximum output length, in characters. Useful for refusal cases. */
		maxLength: z.number().int().min(0).optional(),
	}),
	/** Skip the case in CI but keep it for manual runs. */
	skip: z.boolean().default(false),
	/** Notes for humans reading reports - never used by the grader. */
	notes: z.string().optional(),
});

export type GoldenCase = z.infer<typeof GoldenCase>;
export type SubstringCheck = z.infer<typeof SubstringCheck>;
export type RegexCheck = z.infer<typeof RegexCheck>;
export type ToolCallCheck = z.infer<typeof ToolCallCheck>;
export type LatencyBudget = z.infer<typeof LatencyBudget>;

export interface CapturedToolCall {
	tool: string;
	durationMs: number;
}

/**
 * Raw transport-level result captured by the runner. The grader turns
 * this into a `GradeResult` by applying the case's `expect` block.
 */
export interface AgentRunResult {
	caseId: string;
	prompt: string;
	response: string;
	durationMs: number;
	toolCalls: CapturedToolCall[];
	promptTokensEstimate: number;
	completionTokensEstimate: number;
	error?: string;
}

export interface CheckOutcome {
	name: string;
	passed: boolean;
	detail?: string;
}

export interface GradeResult {
	caseId: string;
	passed: boolean;
	score: number; // 0..1
	checks: CheckOutcome[];
}

export interface CaseResult extends AgentRunResult, GradeResult {
	/** ms epoch */
	startedAt: number;
}

export interface RunSummary {
	runId: string;
	startedAt: number;
	finishedAt: number;
	totalCases: number;
	passed: number;
	failed: number;
	skipped: number;
	score: number; // mean score across executed cases
	p50DurationMs: number;
	p95DurationMs: number;
	p99DurationMs: number;
	totalToolCalls: number;
	totalPromptTokensEstimate: number;
	totalCompletionTokensEstimate: number;
	model: string;
	runtime: string;
}

/** Validate a JSON-parsed object as a GoldenCase. Throws on invalid shape. */
export function parseGoldenCase(raw: unknown): GoldenCase {
	return GoldenCase.parse(raw);
}
