// ── Agent Executor ───────────────────────────────────────────────
// Pluggable execution backend. The runner doesn't care if the agent
// runs against the daemon, the harness, or a direct OpenRouter call —
// it just gets back {output, toolCalls, latencyMs, ...}.

import type { AgentExecutionResult, AgentExecutor, ToolCall } from "./types.js";

// ── OpenRouter Direct Executor ──────────────────────────────────
// Mirrors the pattern in benchmarks/runner.ts. Used as the baseline
// "what does the raw model do" measurement. No tool execution; tool
// calls are inferred from the model's chat output.

export interface OpenRouterExecutorOptions {
	apiKey: string;
	model: string;
	temperature?: number;
	maxTokens?: number;
	systemPrompt?: string;
}

export function createOpenRouterExecutor(opts: OpenRouterExecutorOptions): AgentExecutor {
	const {
		apiKey,
		model,
		temperature = 0.2,
		maxTokens = 2048,
		systemPrompt = "You are 8gent, an autonomous coding agent. Respond concisely and correctly.",
	} = opts;

	return {
		name: `openrouter:${model}`,
		async execute(prompt, context): Promise<AgentExecutionResult> {
			const messages: Array<{ role: string; content: string }> = [
				{ role: "system", content: systemPrompt },
			];
			if (context) messages.push({ role: "system", content: context });
			messages.push({ role: "user", content: prompt });

			const start = Date.now();
			try {
				const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${apiKey}`,
						"HTTP-Referer": "https://8gent.dev",
						"X-Title": "8gent-evals",
					},
					body: JSON.stringify({
						model,
						messages,
						temperature,
						max_tokens: maxTokens,
					}),
				});

				const latencyMs = Date.now() - start;

				if (!res.ok) {
					return {
						output: "",
						toolCalls: [],
						filesTouched: [],
						latencyMs,
						error: `HTTP ${res.status}: ${await res.text()}`,
					};
				}

				const data = (await res.json()) as {
					choices?: Array<{ message?: { content?: string } }>;
					usage?: {
						prompt_tokens?: number;
						completion_tokens?: number;
						total_tokens?: number;
					};
				};

				const output = data.choices?.[0]?.message?.content ?? "";

				return {
					output,
					toolCalls: inferToolCallsFromOutput(output),
					filesTouched: inferFilesFromOutput(output),
					latencyMs,
					tokensUsed: data.usage
						? {
								prompt: data.usage.prompt_tokens ?? 0,
								completion: data.usage.completion_tokens ?? 0,
								total: data.usage.total_tokens ?? 0,
							}
						: undefined,
				};
			} catch (err) {
				return {
					output: "",
					toolCalls: [],
					filesTouched: [],
					latencyMs: Date.now() - start,
					error: err instanceof Error ? err.message : String(err),
				};
			}
		},
	};
}

// ── Mock Executor (used by CI without API keys) ─────────────────

export function createMockExecutor(name = "mock"): AgentExecutor {
	return {
		name,
		async execute(prompt): Promise<AgentExecutionResult> {
			const start = Date.now();
			await new Promise((r) => setTimeout(r, 5));
			return {
				output: `[mock] received prompt: ${prompt.slice(0, 80)}`,
				toolCalls: [],
				filesTouched: [],
				latencyMs: Date.now() - start,
			};
		},
	};
}

// ── Heuristic helpers ───────────────────────────────────────────
// When using a non-tool-calling backend (raw chat completion), we
// have to infer tool intent from the response text. These are best-
// effort and exist so contains/not_contains-only cases still work.

function inferToolCallsFromOutput(output: string): ToolCall[] {
	const calls: ToolCall[] = [];
	const patterns: Array<[RegExp, string]> = [
		[/\b(read_file|read|cat)\b/i, "read"],
		[/\b(write_file|write)\b/i, "write"],
		[/\b(edit_file|edit|patch)\b/i, "edit"],
		[/\b(run_shell|bash|exec|run)\b/i, "bash"],
		[/\b(grep|search|ripgrep|rg)\b/i, "grep"],
		[/\b(list_files|ls|find)\b/i, "list"],
	];
	for (const [re, name] of patterns) {
		if (re.test(output) && !calls.find((c) => c.name === name)) {
			calls.push({ name });
		}
	}
	return calls;
}

function inferFilesFromOutput(output: string): string[] {
	const files = new Set<string>();
	const re = /(?:^|[\s`'"])([./\w-]+\.(?:ts|tsx|js|jsx|json|md|py|go|rs|sh|yml|yaml))\b/g;
	for (const m of output.matchAll(re)) {
		const f = m[1];
		if (f && f.length > 2 && !f.startsWith("../..")) files.add(f);
	}
	return [...files];
}

// ── Selector ────────────────────────────────────────────────────

export function selectExecutor(env = process.env): AgentExecutor {
	const apiKey = env.OPENROUTER_API_KEY;
	const model = env.EVALS_MODEL ?? "qwen/qwen-2.5-72b-instruct:free";
	if (apiKey && env.EVALS_USE_MOCK !== "1") {
		return createOpenRouterExecutor({ apiKey, model });
	}
	return createMockExecutor("mock-no-api-key");
}
