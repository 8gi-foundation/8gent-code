// ── Golden Test Case Schema ──────────────────────────────────────
// Issue #2421: Golden test sets and measurement baselines.
// "You can't optimize what you don't measure." - Rob Pike's Rule 1

export type GoldenCategory = "tool_use" | "reasoning" | "code_gen" | "memory" | "multi_step";

export interface GoldenExpectations {
	/** Output MUST contain all of these substrings (case-insensitive). */
	contains?: string[];
	/** Output MUST NOT contain any of these substrings (case-insensitive). */
	not_contains?: string[];
	/** Tool names that should appear in the call trace. */
	tool_calls?: string[];
	/** Files that should be created or modified during the run. */
	file_outputs?: string[];
	/** Free-form rubric for the LLM-as-judge to score 0-100. */
	quality_rubric?: string;
}

export interface GoldenTestCase {
	id: string;
	name: string;
	category: GoldenCategory;
	prompt: string;
	/** Optional session/system context preloaded before the prompt. */
	context?: string;
	expected: GoldenExpectations;
	/** Wall-clock cap. Cases that exceed this fail. */
	timeout_ms: number;
}

export interface GoldenSet {
	version: string;
	updated: string;
	cases: GoldenTestCase[];
}

// ── Execution Result ─────────────────────────────────────────────

export interface ToolCall {
	name: string;
	input?: unknown;
	output?: unknown;
}

export interface AgentExecutionResult {
	output: string;
	toolCalls: ToolCall[];
	filesTouched: string[];
	latencyMs: number;
	tokensUsed?: {
		prompt: number;
		completion: number;
		total: number;
	};
	error?: string;
}

export interface AgentExecutor {
	name: string;
	execute(prompt: string, context?: string): Promise<AgentExecutionResult>;
}

// ── Scoring ──────────────────────────────────────────────────────

export interface ScoreBreakdown {
	contains: { passed: boolean; matched: string[]; missed: string[] };
	notContains: { passed: boolean; violated: string[] };
	toolCalls: { passed: boolean; matched: string[]; missed: string[] };
	fileOutputs: { passed: boolean; matched: string[]; missed: string[] };
	rubric: { score: number | null; analysis: string | null };
}

export interface CaseScore {
	caseId: string;
	passed: boolean;
	/** 0-100 blended score. */
	score: number;
	breakdown: ScoreBreakdown;
}

export interface CaseRunResult {
	case: GoldenTestCase;
	execution: AgentExecutionResult;
	score: CaseScore;
	timedOut: boolean;
}

// ── Aggregate / Baseline ────────────────────────────────────────

export interface LatencyStats {
	count: number;
	mean: number;
	p50: number;
	p95: number;
	p99: number;
	min: number;
	max: number;
}

export interface EvalReport {
	version: string;
	timestamp: string;
	executor: string;
	cases: CaseRunResult[];
	summary: {
		total: number;
		passed: number;
		failed: number;
		passRate: number;
		meanScore: number;
		latency: LatencyStats;
		categoryBreakdown: Record<string, { passed: number; total: number }>;
	};
}

export interface BaselineSnapshot {
	version: string;
	createdAt: string;
	executor: string;
	perCase: Record<
		string,
		{
			passed: boolean;
			score: number;
			latencyMs: number;
		}
	>;
	summary: EvalReport["summary"];
}

export interface RegressionReport {
	regressions: Array<{
		caseId: string;
		kind: "score" | "passing" | "latency";
		baseline: number | boolean;
		current: number | boolean;
		delta: number;
	}>;
	improvements: Array<{
		caseId: string;
		kind: "score" | "passing" | "latency";
		baseline: number | boolean;
		current: number | boolean;
		delta: number;
	}>;
	hasRegressions: boolean;
}
