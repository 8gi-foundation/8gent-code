import { resolveRoleName } from "../settings/index.js";

export interface RunnerConfig {
	role: string;
	systemPrompt: string;
	allowedTools: string[];
	retryPolicy: { maxAttempts: number; backoffMs: number };
	inferenceMode?: "ollama" | "lmstudio" | "openrouter" | "apfel" | "apple-foundation";
	model?: string;
}

/**
 * Internal: each role's system prompt as a template. `{name}` is the only
 * placeholder; getRunnerConfig() interpolates the user-chosen display name
 * (settings.agents.names[role]) at read time so renaming the role through
 * onboarding flows into the agent prompt without code changes.
 */
const ROLE_PROMPT_TEMPLATES: Record<string, string> = {
	orchestrator:
		"You are {name}. Plan, delegate, and coordinate. Think before acting. No code - direct others.",
	engineer:
		"You are {name}. Write code, edit files, run commands. Implement exactly what is asked. No fluff.",
	qa:
		"You are {name}. Find bugs, review diffs, run tests. Be harsh. Reject anything that doesn't meet the spec.",
};

function buildSystemPrompt(role: string): string {
	const template = ROLE_PROMPT_TEMPLATES[role] ?? ROLE_PROMPT_TEMPLATES.engineer;
	return template.replace("{name}", resolveRoleName(role));
}

export const ROLE_REGISTRY: Record<string, RunnerConfig> = {
	orchestrator: {
		role: "orchestrator",
		// systemPrompt lazily reads the user-chosen display name on first read so
		// the static export stays a useful default for tests/snapshots.
		get systemPrompt(): string {
			return buildSystemPrompt("orchestrator");
		},
		allowedTools: ["write_notes", "gh_issue_create", "gh_pr_list", "gh_issue_list"],
		retryPolicy: { maxAttempts: 2, backoffMs: 1000 },
		// Heavy reasoning model for planning + coordination.
		inferenceMode: "ollama",
		model: "qwen3.6:27b",
	},
	engineer: {
		role: "engineer",
		get systemPrompt(): string {
			return buildSystemPrompt("engineer");
		},
		allowedTools: [
			"read_file",
			"write_file",
			"edit_file",
			"list_files",
			"run_command",
			"git_status",
			"git_diff",
			"git_add",
			"git_commit",
			"git_push",
			"git_branch",
			"git_checkout",
			"get_outline",
			"get_symbol",
			"search_symbols",
		],
		retryPolicy: { maxAttempts: 3, backoffMs: 2000 },
		// LM Studio for tool-call density - gemma 4-26b is strong on code.
		inferenceMode: "lmstudio",
		model: "google/gemma-4-26b-a4b",
	},
	qa: {
		role: "qa",
		get systemPrompt(): string {
			return buildSystemPrompt("qa");
		},
		allowedTools: [
			"read_file",
			"list_files",
			"run_command",
			"git_diff",
			"git_status",
			"git_log",
			"get_outline",
		],
		retryPolicy: { maxAttempts: 2, backoffMs: 1000 },
		// On-device review via apfel (Apple Foundation Model). apfel exposes an
		// OpenAI-compatible HTTP server, so it slots into the AI SDK provider
		// registry directly. Run with `apfel --serve --port 11500`.
		// Override URL via APFEL_BASE_URL.
		inferenceMode: "apfel",
		model: "apple-foundationmodel",
	},
};

export function getRunnerConfig(role: string): RunnerConfig {
	const cfg = ROLE_REGISTRY[role] ?? ROLE_REGISTRY.engineer;
	// Materialize systemPrompt to a plain string for callers that destructure
	// or pass the object across boundaries (e.g. tab data persistence). The
	// static `ROLE_REGISTRY[role].systemPrompt` getter still works for direct
	// access; this just guarantees serializability for downstream consumers.
	return {
		...cfg,
		systemPrompt: cfg.systemPrompt,
	};
}
