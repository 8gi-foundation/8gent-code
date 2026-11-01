/**
 * Officer agent runner — gives a board vessel a real agent loop instead of
 * the single-text-call inference in `inference.ts`.
 *
 * Each officer code maps to a job-spec system prompt + a focused tool subset.
 * The runner uses `runAgent` from `packages/ai`, which carries the failover
 * loop and the AI SDK tool registry. This is what turns an officer from a
 * "be visionary" persona into something that can actually triage an issue
 * with file:line citations.
 *
 * MVP: 8TO only. Pattern is replicable to the other officers.
 */

import type { ProviderConfig } from "../ai/providers";
import { runAgent } from "../ai/agent";

export interface OfficerRunInput {
	code: string;
	task: string;
	provider?: ProviderConfig;
	maxSteps?: number;
	workingDirectory?: string;
}

export interface OfficerRunOutput {
	officer: string;
	text: string;
	steps: number;
	totalTokens: number;
}

const TECH_OFFICER_TOOLS = [
	"read_file",
	"list_files",
	"git_status",
	"git_diff",
	"git_log",
	"gh_issue_list",
	"gh_issue_create",
	"gh_pr_list",
	"gh_pr_view",
	"run_command", // for grep, sed, ast queries the agent decides on
	"get_outline",
	"get_symbol",
	"search_symbols",
];

/**
 * Job-spec system prompts. Each one is a CONTRACT, not a personality.
 * The acceptance criteria + anti-fluff bar are what shifts output away
 * from LinkedIn summaries toward real engineering evidence.
 */
const OFFICER_PROMPTS: Record<
	string,
	{ prompt: string; allowedTools: readonly string[] }
> = {
	"8TO": {
		prompt: `You are 8TO (Rishi), 8gent Technology Officer of the 8GI Foundation.

YOUR JOB
When you get a task, do real engineering work. Read the actual code. Run real commands. Post evidence, not strategy. You are NOT a project manager and NOT a visionary. You are a senior engineer who delivers triage, root-cause analysis, and concrete fixes.

ACCEPTANCE CRITERIA (every response, no exceptions)
1. Cite at least one real file_path:line_number from the codebase.
2. Show what you read or ran. Quote a snippet, paste a diff, paste tool output.
3. End with a concrete next step that names a file, command, or PR.
4. No motivational summaries. No "we should". No "I would". Use the imperative or past tense.

TOOLS
You have read_file, list_files, get_outline, get_symbol, search_symbols, git_status, git_diff, git_log, gh_issue_list, gh_pr_list, gh_pr_view, gh_issue_create, run_command. Use them. Don't speculate when you can verify in one tool call.

WORKFLOW
1. Identify the files relevant to the task. read_file or get_outline on each.
2. Run grep / search_symbols to confirm callers and dependencies.
3. State the actual root cause with a file:line citation.
4. Propose a fix with the smallest possible blast radius.
5. If something is genuinely blocked (missing data, missing access), name the specific blocker. Don't pad.

PROHIBITED OUTPUT
- "Visionary"
- "Empower"
- "Strategic alignment"
- Issues that ask another officer to do work YOU could have done with the tools you already have.
- Bullet lists with no file references.
- Summaries that restate the task without doing it.

TONE
Direct. Technical. No padding. If the task is two sentences of work, deliver two sentences. If it requires a deep dive, deliver the dive with citations.`,
		allowedTools: TECH_OFFICER_TOOLS,
	},
};

/**
 * Run an officer agent against a task. Returns the agent's final text +
 * step + token counts. The caller is responsible for routing the result
 * (Discord post, GitHub comment, etc.).
 */
export async function runOfficerAgent(input: OfficerRunInput): Promise<OfficerRunOutput> {
	const officerCode = input.code.toUpperCase();
	const cfg = OFFICER_PROMPTS[officerCode];
	if (!cfg) {
		throw new Error(
			`Unknown officer code: ${input.code}. Configured: ${Object.keys(OFFICER_PROMPTS).join(", ")}`,
		);
	}

	const provider = input.provider ?? {
		name: "ollama" as const,
		model: process.env.OLLAMA_MODEL || "qwen3.6:27b",
	};

	const result = await runAgent(
		{
			provider,
			instructions: cfg.prompt,
			maxSteps: input.maxSteps ?? 15,
			workingDirectory: input.workingDirectory ?? process.cwd(),
			// Note: we don't filter tools here. The CORE_TOOLS allowlist in
			// packages/ai/agent.ts already trims for local providers, and the
			// system prompt steers the agent toward the right subset.
		},
		input.task,
	);

	return {
		officer: officerCode,
		text: result.text,
		steps: result.steps,
		totalTokens: result.usage.totalTokens,
	};
}

/**
 * Lookup a configured officer prompt. Used by tests and by the deployed
 * vessel runtime when it wants to swap in the new agent loop for a specific
 * officer code without changing every other officer.
 */
export function getOfficerPrompt(code: string): string | null {
	return OFFICER_PROMPTS[code.toUpperCase()]?.prompt ?? null;
}
