// ── Scorer ────────────────────────────────────────────────────────
// Combines deterministic checks (contains/not_contains/tool_calls/files)
// with optional LLM-as-judge scoring for the quality_rubric field.
// Per CLAUDE.md AI Judging Rule: never use string matching for QUALITY
// evaluation — but for explicit string-presence checks (which is what
// `contains` IS), it's the correct primitive.

import type { AgentExecutionResult, CaseScore, GoldenTestCase, ScoreBreakdown } from "./types.js";

const DEFAULT_JUDGE_MODEL = "google/gemini-2.0-flash-001";

export interface ScorerOptions {
	/** OpenRouter API key for LLM-as-judge. If absent, rubric scoring is skipped. */
	judgeApiKey?: string;
	judgeModel?: string;
}

export async function scoreCase(
	testCase: GoldenTestCase,
	execution: AgentExecutionResult,
	opts: ScorerOptions = {},
): Promise<CaseScore> {
	const breakdown: ScoreBreakdown = {
		contains: scoreContains(execution.output, testCase.expected.contains),
		notContains: scoreNotContains(execution.output, testCase.expected.not_contains),
		toolCalls: scoreToolCalls(
			execution.toolCalls.map((c) => c.name),
			testCase.expected.tool_calls,
		),
		fileOutputs: scoreFileOutputs(execution.filesTouched, testCase.expected.file_outputs),
		rubric: { score: null, analysis: null },
	};

	if (testCase.expected.quality_rubric && opts.judgeApiKey) {
		const judged = await llmAsJudge({
			rubric: testCase.expected.quality_rubric,
			prompt: testCase.prompt,
			output: execution.output,
			apiKey: opts.judgeApiKey,
			model: opts.judgeModel ?? DEFAULT_JUDGE_MODEL,
		});
		breakdown.rubric = judged;
	}

	const { score, passed } = blend(breakdown, testCase, execution);
	return {
		caseId: testCase.id,
		passed,
		score,
		breakdown,
	};
}

// ── Deterministic checks ────────────────────────────────────────

function scoreContains(output: string, expected: string[] | undefined): ScoreBreakdown["contains"] {
	if (!expected || expected.length === 0) {
		return { passed: true, matched: [], missed: [] };
	}
	const lower = output.toLowerCase();
	const matched: string[] = [];
	const missed: string[] = [];
	for (const s of expected) {
		if (lower.includes(s.toLowerCase())) matched.push(s);
		else missed.push(s);
	}
	return { passed: missed.length === 0, matched, missed };
}

function scoreNotContains(
	output: string,
	forbidden: string[] | undefined,
): ScoreBreakdown["notContains"] {
	if (!forbidden || forbidden.length === 0) {
		return { passed: true, violated: [] };
	}
	const lower = output.toLowerCase();
	const violated = forbidden.filter((s) => lower.includes(s.toLowerCase()));
	return { passed: violated.length === 0, violated };
}

function scoreToolCalls(
	actual: string[],
	expected: string[] | undefined,
): ScoreBreakdown["toolCalls"] {
	if (!expected || expected.length === 0) {
		return { passed: true, matched: [], missed: [] };
	}
	const actualSet = new Set(actual.map((a) => a.toLowerCase()));
	const matched: string[] = [];
	const missed: string[] = [];
	for (const t of expected) {
		if (actualSet.has(t.toLowerCase())) matched.push(t);
		else missed.push(t);
	}
	return { passed: missed.length === 0, matched, missed };
}

function scoreFileOutputs(
	actual: string[],
	expected: string[] | undefined,
): ScoreBreakdown["fileOutputs"] {
	if (!expected || expected.length === 0) {
		return { passed: true, matched: [], missed: [] };
	}
	const matched: string[] = [];
	const missed: string[] = [];
	for (const f of expected) {
		if (actual.some((a) => a.endsWith(f) || a === f)) matched.push(f);
		else missed.push(f);
	}
	return { passed: missed.length === 0, matched, missed };
}

// ── LLM-as-judge ────────────────────────────────────────────────

async function llmAsJudge(args: {
	rubric: string;
	prompt: string;
	output: string;
	apiKey: string;
	model: string;
}): Promise<ScoreBreakdown["rubric"]> {
	const judgePrompt = `You are an expert evaluator scoring an AI agent's response against a quality rubric.

## Task given to agent
${args.prompt}

## Rubric
${args.rubric}

## Agent's response
${args.output.slice(0, 4000)}

Score 0-100 strictly against the rubric. Output ONLY valid JSON, no prose:
{"score": <0-100>, "analysis": "<one sentence>"}`;

	try {
		const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${args.apiKey}`,
				"HTTP-Referer": "https://8gent.dev",
				"X-Title": "8gent-evals-judge",
			},
			body: JSON.stringify({
				model: args.model,
				messages: [{ role: "user", content: judgePrompt }],
				temperature: 0.1,
				max_tokens: 200,
			}),
		});

		if (!res.ok) {
			return {
				score: null,
				analysis: `judge http ${res.status}`,
			};
		}

		const data = (await res.json()) as {
			choices?: Array<{ message?: { content?: string } }>;
		};
		const raw = data.choices?.[0]?.message?.content ?? "";
		const jsonMatch = raw.match(/\{[\s\S]*\}/);
		if (!jsonMatch) return { score: null, analysis: "no json in judge output" };
		const parsed = JSON.parse(jsonMatch[0]) as {
			score?: number;
			analysis?: string;
		};
		const score =
			typeof parsed.score === "number" ? Math.max(0, Math.min(100, parsed.score)) : null;
		return { score, analysis: parsed.analysis ?? null };
	} catch (err) {
		return {
			score: null,
			analysis: `judge error: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

// ── Blend ───────────────────────────────────────────────────────

function blend(
	b: ScoreBreakdown,
	testCase: GoldenTestCase,
	execution: AgentExecutionResult,
): { score: number; passed: boolean } {
	if (execution.error) {
		return { score: 0, passed: false };
	}

	const checks: Array<{ weight: number; pass: boolean; score?: number }> = [];

	if (testCase.expected.contains?.length) {
		const ratio = b.contains.matched.length / (testCase.expected.contains.length || 1);
		checks.push({
			weight: 30,
			pass: b.contains.passed,
			score: ratio * 100,
		});
	}
	if (testCase.expected.not_contains?.length) {
		checks.push({
			weight: 20,
			pass: b.notContains.passed,
			score: b.notContains.passed ? 100 : 0,
		});
	}
	if (testCase.expected.tool_calls?.length) {
		const ratio = b.toolCalls.matched.length / (testCase.expected.tool_calls.length || 1);
		checks.push({
			weight: 20,
			pass: b.toolCalls.passed,
			score: ratio * 100,
		});
	}
	if (testCase.expected.file_outputs?.length) {
		const ratio = b.fileOutputs.matched.length / (testCase.expected.file_outputs.length || 1);
		checks.push({
			weight: 15,
			pass: b.fileOutputs.passed,
			score: ratio * 100,
		});
	}
	if (b.rubric.score !== null) {
		checks.push({
			weight: 30,
			pass: b.rubric.score >= 60,
			score: b.rubric.score,
		});
	}

	if (checks.length === 0) {
		return { score: execution.output.length > 0 ? 50 : 0, passed: true };
	}

	const totalWeight = checks.reduce((s, c) => s + c.weight, 0);
	const weightedScore =
		checks.reduce((s, c) => s + c.weight * (c.score ?? (c.pass ? 100 : 0)), 0) / totalWeight;
	const passed = checks.every((c) => c.pass);

	return { score: Math.round(weightedScore * 10) / 10, passed };
}
