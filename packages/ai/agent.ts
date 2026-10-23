/**
 * 8gent AI - Agent (AI SDK powered)
 *
 * Wraps the Vercel AI SDK ToolLoopAgent to provide the 8gent agent experience.
 * Replaces the manual agentic loop in packages/eight/agent.ts with the SDK's
 * built-in tool loop via generateText + stopWhen.
 *
 * v2: Events now carry full AI SDK data (finishReason, reasoning, sources,
 * files, response metadata, provider metadata, detailed token usage).
 */

import { ToolLoopAgent, stepCountIs } from "ai";
import type { GenerateTextResult, LanguageModel, ModelMessage, ToolSet } from "ai";
import { resolveRetrySettings } from "../settings/retry";
import { loadSettings } from "../settings/store";
import { type ProviderConfig, createModel } from "./providers";
import { silentCallsNoteForSteps, silentCallsRunForSteps } from "./silent-calls";
import { capToolResults } from "./tool-result-cap";
import {
	type AgentTools,
	type RuntimeParams,
	type ToolContext,
	agentTools,
	getRuntimeParams,
} from "./tools";
import { createBudgetDrain, resolveTurnBudgetMs } from "./turn-budget";

export interface EightAgentConfig {
	/** Tool calls with no prose between them before a step runs without tools and reports (#4791). 0 or unset: off. */
	silentCalls?: number;
	/** With silentCalls: one progress line at the threshold and the run carries on (#4794). */
	silentProgress?: (line: string) => void;
	/** Provider configuration */
	provider: ProviderConfig;
	/** System instructions */
	instructions?: string;
	/** Max steps (default: 30) */
	maxSteps?: number;
	/** Working directory */
	workingDirectory?: string;
	/** Agent scope for the write-policy gate (default "primary"). */
	agentId?: string;
	/** This agent's runtime params (default: the process fallback). */
	runtime?: RuntimeParams;
	/** This agent's permission mode, bound to each native tool call (#3170). */
	permission?: import("../permissions/permission-mode").PermissionModeHolder;
	/** Files this agent created (#3177), shared with its ToolExecutor so both tool paths record into one place. */
	createdFiles?: import("../permissions/s1-created-files").CreatedFiles;
	/** Edit scope of this agent; the media write tools refuse outside it. */
	allowedPaths?: string[];
	/** Tools to use (default: all agentTools) */
	tools?: ToolSet;
	/** Max output tokens per step (default: 4096 for local, unlimited for cloud) */
	maxOutputTokens?: number;
	/** Generation parameters (tunable by the agent via self_tune) */
	temperature?: number;
	topP?: number;
	topK?: number;
	frequencyPenalty?: number;
	presencePenalty?: number;
	/** Callback fired before each model call (step), with the step index only. */
	onStepStart?: (event: StepStartEvent) => void | Promise<void>;
	/**
	 * Steering (D1). Drained before every model call after the first: each
	 * string becomes a user message placed after the tool results that existed
	 * when it was drained, and stays there for the rest of this generate() run.
	 */
	steer?: () => string[];
	/** Whole-turn time budget in ms for the best-answer nudge (default EIGHT_TURN_BUDGET_MS; 0 disables) */
	turnBudgetMs?: number;
	/** Turn start (epoch ms) for the budget clock; defaults to agent creation */
	turnStartedAt?: number;
	/** Fraction of the turn budget at which the nudge fires (per-model profile, #4439) */
	nudgeFraction?: number;
	/** Model override (tests); defaults to createModel(config.provider) */
	model?: LanguageModel;
	/** Callback for each step */
	onStepFinish?: (event: StepFinishEvent) => void | Promise<void>;
	/**
	 * Refusal gate, run inside every native tool's execute before it runs. A
	 * string refuses the call: the tool never runs and the model gets the
	 * string as the tool error. Null lets it run. This is the place for checks
	 * that must stop a call: the SDK swallows anything thrown from
	 * onToolCallStart, so a throw there never stopped a tool.
	 */
	gateToolCall?: (event: ToolCallStartEvent) => string | null | Promise<string | null>;
	/** Callback for tool call start (observation only: a throw here does not stop the call) */
	onToolCallStart?: (event: ToolCallStartEvent) => void | Promise<void>;
	/** Callback for tool call finish */
	onToolCallFinish?: (event: ToolCallFinishEvent) => void | Promise<void>;
	/** Callback when generation finishes */
	onFinish?: (event: FinishEvent) => void | Promise<void>;
}

export interface StepStartEvent {
	/** Step number (0-based) */
	stepNumber: number;
}

export interface StepFinishEvent {
	/** Step number (0-based) */
	stepNumber: number;
	/** Step type: "initial" or "tool-result" */
	stepType: string;
	/** Text generated in this step */
	text: string;
	/** Why this step finished (maps to AI SDK FinishReason) */
	finishReason: string;
	/** Raw finish reason from provider */
	rawFinishReason?: string;
	/** Wall-clock duration of the LLM call for this step (ms). Excludes
	 *  tool execution time when a tool ran in the previous step. */
	durationMs?: number;
	/** Output tokens per second observed for this step (instantaneous,
	 *  not smoothed). 0 if the step generated no completion tokens. */
	tokensPerSecond?: number;
	/** Reasoning/thinking content if model supports it */
	reasoning?: Array<{ type: string; text: string; signature?: string }>;
	/** Reasoning as flat text */
	reasoningText?: string;
	/** Sources/references used */
	sources?: Array<{ type: string; id: string; url?: string; title?: string }>;
	/** Generated files */
	files?: Array<{ mediaType: string; data: string }>;
	/** Tool calls made in this step */
	toolCalls: Array<{
		toolCallId: string;
		toolName: string;
		args: Record<string, unknown>;
	}>;
	/** Tool results from this step */
	toolResults: Array<{ toolCallId: string; toolName: string; result: unknown }>;
	/** Detailed token usage */
	usage: {
		promptTokens: number;
		completionTokens: number;
		totalTokens: number;
		inputTokenDetails?: {
			noCacheTokens?: number;
			cacheReadTokens?: number;
			cacheWriteTokens?: number;
		};
		outputTokenDetails?: {
			textTokens?: number;
			reasoningTokens?: number;
		};
		raw?: Record<string, unknown>;
	};
	/** Model info for this step */
	model?: { provider: string; modelId: string };
	/** Response metadata from provider */
	response?: {
		id?: string;
		timestamp?: string;
		modelId?: string;
		headers?: Record<string, string>;
	};
	/** Provider-specific pass-through metadata */
	providerMetadata?: Record<string, unknown>;
}

export interface ToolCallStartEvent {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	stepNumber?: number;
}

export interface ToolCallFinishEvent {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	success: boolean;
	result?: unknown;
	error?: unknown;
	durationMs: number;
	stepNumber?: number;
}

export interface FinishEvent {
	text: string;
	finishReason: string;
	usage: StepFinishEvent["usage"];
	totalUsage: StepFinishEvent["usage"];
	steps: StepFinishEvent[];
	response?: StepFinishEvent["response"];
}

/**
 * Create an 8gent AI agent powered by the Vercel AI SDK.
 */
export function createEightAgent(config: EightAgentConfig): ToolLoopAgent<never, AgentTools> {
	// This agent's own tool context, handed to every tool call through the SDK
	// (#3127). Never written to module state, so a second agent cannot move it.
	const toolContext: ToolContext = {
		workingDirectory: config.workingDirectory || process.cwd(),
		agentId: config.agentId ?? "primary",
		runtime: config.runtime ?? getRuntimeParams(),
		permission: config.permission,
		createdFiles: config.createdFiles,
		allowedPaths: config.allowedPaths,
	};

	const model = config.model ?? createModel(config.provider);

	// Track per-step timing for tokens-per-second measurement. Reset at the
	// start of each LLM call: build start, after tool returns, and after each
	// onStepFinish. The first measurement covers the initial step; subsequent
	// measurements cover only the LLM portion (tool execution time excluded).
	let stepStartedAt = Date.now();
	// Some AI SDK providers report per-step output tokens; others return the
	// running cumulative across the whole generateText run. Treat the figure
	// as cumulative-since-last-measurement: keep the previous value, take a
	// non-negative delta, reset on a downward jump (new turn / new run). This
	// behaves correctly under either semantic without the harness having to
	// know which one the provider chose.
	let lastSeenOutputTokens = 0;
	// Exponentially-weighted rolling tps so the bottom-bar number doesn't
	// jitter on tiny one-token chunks. Alpha 0.3 keeps it responsive but stable.
	let smoothedTps = 0;

	// LM Studio has limited context — 49 tools blows the context window.
	// For local providers, use only the core coding tools.
	const CORE_TOOLS = [
		"read_file",
		"write_file",
		"edit_file",
		"list_files",
		"run_command",
		"git_status",
		"git_diff",
		"git_add",
		"git_commit",
		// Desktop / hands - so local models can drive the screen too
		"desktop_screenshot",
		"desktop_click",
		"desktop_type",
		"desktop_press",
		"desktop_scroll",
		"desktop_drag",
		"desktop_hover",
		"desktop_windows",
		"desktop_clipboard",
		// Self-evolution - free will to author skills
		"propose_skill_creation",
	];
	const defaultTools =
		config.provider.name === "lmstudio" || config.provider.name === "ollama"
			? (Object.fromEntries(
					Object.entries(agentTools).filter(([k]) => CORE_TOOLS.includes(k)),
				) as AgentTools)
			: agentTools;
	const offered = (config.tools as AgentTools) || defaultTools;
	const tools = config.gateToolCall ? gateTools(offered, config.gateToolCall) : offered;

	const isLocalProvider = config.provider.name === "lmstudio" || config.provider.name === "ollama";

	// Steering messages drained during the current generate() run, each with
	// the position it was inserted at. Reset when a run starts again (step 0).
	const steerLog: SteerEntry[] = [];
	// Whole-turn budget (#4418): near the end of the budget, one steer asks the
	// model to write its best answer to the requested output. It rides the same
	// steer log, so it persists for every later step of the run.
	const budgetMs = config.turnBudgetMs ?? resolveTurnBudgetMs();
	const budgetDrain = createBudgetDrain({
		budgetMs,
		startedAt: config.turnStartedAt,
		nudgeFraction: config.nudgeFraction,
	});
	// Silent tool calls (#4791): after N calls with no prose, one step runs with
	// tool use off and a note asking for a progress line and whether to keep going.
	const silentThreshold = config.silentCalls ?? 0;
	const silentPending: string[] = [];
	let silentFired = false;
	// Carry-on mode: steps before this index were already reported.
	let silentFrom = 0;
	const steer = (): string[] => [
		...(config.steer?.() ?? []),
		...budgetDrain(),
		...silentPending.splice(0),
	];

	// Retries per request: only when the user set settings.retry.maxRetries; otherwise the
	// AI SDK's own default stays (C4).
	const configuredRetries = resolveRetrySettings(loadSettings().retry).maxRetries;

	const agent = new ToolLoopAgent<never, AgentTools>({
		model,
		instructions: config.instructions,
		...(configuredRetries !== undefined ? { maxRetries: configuredRetries } : {}),
		// Cap response size for local providers to keep within their context window
		...(config.maxOutputTokens
			? { maxOutputTokens: config.maxOutputTokens }
			: isLocalProvider
				? { maxOutputTokens: 4096 }
				: {}),
		// Generation params (tunable via self_tune)
		...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
		...(config.topP !== undefined ? { topP: config.topP } : {}),
		// topK is only supported by Anthropic/Google. Every other provider (OpenAI-compatible
		// ones like minimax) rejects it with an "AI SDK Warning", so it is sent to those two only.
		...(config.topK !== undefined &&
		["anthropic", "google", "gemini"].includes(config.provider.name)
			? { topK: config.topK }
			: {}),
		...(config.frequencyPenalty !== undefined ? { frequencyPenalty: config.frequencyPenalty } : {}),
		...(config.presencePenalty !== undefined ? { presencePenalty: config.presencePenalty } : {}),
		tools,
		experimental_context: toolContext,
		stopWhen: stepCountIs(config.maxSteps || 30),
		// Fires before every model call. onStepStart is observation only and a
		// throwing callback never breaks the loop. Two things change the step:
		// steering (D1) splices drained messages in, see steerMessages,
		// and every tool result is capped (tool-result-cap.ts).
		prepareStep: async ({
			stepNumber,
			messages,
			steps,
		}: {
			stepNumber: number;
			messages: ModelMessage[];
			steps?: ReadonlyArray<{
				text?: string;
				toolCalls?: ReadonlyArray<{ toolName?: string }>;
			}>;
		}) => {
			try {
				await config.onStepStart?.({ stepNumber });
			} catch {
				/* step-start logging is best-effort */
			}
			// Each generate() is a new turn: restart the budget clock.
			if (stepNumber === 0) budgetDrain.reset();
			if (stepNumber === 0) {
				silentFired = false;
				silentFrom = 0;
			}
			if (config.silentProgress && silentThreshold > 0 && stepNumber > 0) {
				const run = silentCallsRunForSteps((steps ?? []).slice(silentFrom), silentThreshold);
				if (run) {
					silentFrom = steps?.length ?? 0;
					config.silentProgress(run.takeProgress());
				}
			}
			let silentStop = false;
			if (!config.silentProgress && !silentFired && silentThreshold > 0 && stepNumber > 0) {
				const note = silentCallsNoteForSteps(steps ?? [], silentThreshold);
				if (note) {
					silentFired = true;
					silentStop = true;
					silentPending.push(note);
				}
			}
			const capped = capToolResults(messages);
			const steered =
				steerMessages(steerLog, stepNumber, capped, steer) ?? (capped !== messages ? capped : null);
			if (silentStop)
				return { ...(steered ? { messages: steered } : {}), toolChoice: "none" as const };
			return steered ? { messages: steered } : undefined;
		},

		onStepFinish: config.onStepFinish
			? (event: any) => {
					const durationMs = Math.max(1, Date.now() - stepStartedAt);
					const cumulativeOutputTokens = mapUsage(event.usage).completionTokens || 0;
					// Detect a downward jump (new generateText run): reset the
					// baseline so we don't flag a negative delta as "no progress".
					if (cumulativeOutputTokens < lastSeenOutputTokens) {
						lastSeenOutputTokens = 0;
					}
					const stepOutputTokens = cumulativeOutputTokens - lastSeenOutputTokens;
					lastSeenOutputTokens = cumulativeOutputTokens;
					// Gate: ignore "tool-result" intermediate steps that emit
					// no new tokens, and ignore implausibly fast measurements
					// (durationMs < 200ms typically means the timer was reset
					// by an upstream callback after the LLM already started).
					// Cap at 5000 t/s — well above any real provider — so a
					// stale measurement can never poison the EWMA.
					const isPlausible = stepOutputTokens >= 5 && durationMs >= 200;
					const instantTps = isPlausible
						? Math.min(5000, (stepOutputTokens / durationMs) * 1000)
						: 0;
					if (instantTps > 0) {
						smoothedTps = smoothedTps === 0 ? instantTps : smoothedTps * 0.7 + instantTps * 0.3;
						Object.assign(toolContext.runtime as RuntimeParams, {
							lastTokensPerSecond: instantTps,
							avgTokensPerSecond: smoothedTps,
						});
					}
					stepStartedAt = Date.now();
					const stepEvent: StepFinishEvent = {
						stepNumber: event.stepNumber ?? 0,
						stepType: event.stepType ?? "unknown",
						text: event.text ?? "",
						finishReason: event.finishReason ?? "other",
						rawFinishReason: event.rawFinishReason,
						durationMs,
						tokensPerSecond: instantTps,
						reasoning: event.reasoning?.length
							? event.reasoning.map((r: any) => ({
									type: r.type ?? "reasoning",
									text: r.text ?? "",
									signature: r.signature,
								}))
							: undefined,
						reasoningText: event.reasoningText || undefined,
						sources: event.sources?.length
							? event.sources.map((s: any) => ({
									type: s.sourceType ?? s.type ?? "unknown",
									id: s.id ?? "",
									url: s.url,
									title: s.title,
								}))
							: undefined,
						files: event.files?.length
							? event.files.map((f: any) => ({
									mediaType: f.mediaType ?? "application/octet-stream",
									data: typeof f.base64 === "string" ? f.base64 : "",
								}))
							: undefined,
						toolCalls: (event.toolCalls ?? []).map((tc: any) => ({
							toolCallId: tc.toolCallId ?? "",
							toolName: tc.toolName ?? "",
							args: tc.args ?? tc.input ?? {},
						})),
						toolResults: (event.toolResults ?? []).map((tr: any) => ({
							toolCallId: tr.toolCallId ?? "",
							toolName: tr.toolName ?? "",
							result: tr.result ?? tr.output,
						})),
						usage: mapUsage(event.usage),
						model: event.model
							? { provider: event.model.provider, modelId: event.model.modelId }
							: undefined,
						response: event.response
							? {
									id: event.response.id,
									timestamp: event.response.timestamp
										? new Date(event.response.timestamp).toISOString()
										: undefined,
									modelId: event.response.modelId,
									headers: event.response.headers,
								}
							: undefined,
						providerMetadata: event.providerMetadata || undefined,
					};
					return config.onStepFinish?.(stepEvent);
				}
			: undefined,

		experimental_onToolCallStart: config.onToolCallStart
			? (event: any) => {
					return config.onToolCallStart?.({
						toolCallId: event.toolCall?.toolCallId ?? "",
						toolName: event.toolCall?.toolName ?? "",
						args: event.toolCall?.args ?? event.toolCall?.input ?? {},
						stepNumber: event.stepNumber,
					});
				}
			: undefined,

		experimental_onToolCallFinish: (event: any) => {
			// Tool finished → next LLM step is about to start. Reset the timer
			// so the next durationMs measures only that LLM call, not the gap.
			stepStartedAt = Date.now();
			return config.onToolCallFinish?.({
				toolCallId: event.toolCall?.toolCallId ?? "",
				toolName: event.toolCall?.toolName ?? "",
				args: event.toolCall?.args ?? event.toolCall?.input ?? {},
				success: event.success ?? true,
				result: event.output,
				error: event.error,
				durationMs: event.durationMs ?? 0,
				stepNumber: event.stepNumber,
			});
		},

		onFinish: config.onFinish
			? (event: any) => {
					return config.onFinish?.({
						text: event.text ?? "",
						finishReason: event.finishReason ?? "other",
						usage: mapUsage(event.usage),
						totalUsage: mapUsage(event.totalUsage ?? event.usage),
						steps: (event.steps ?? []).map((s: any, i: number) => ({
							stepNumber: s.stepNumber ?? i,
							stepType: s.stepType ?? "unknown",
							text: s.text ?? "",
							finishReason: s.finishReason ?? "other",
							toolCalls: s.toolCalls ?? [],
							toolResults: s.toolResults ?? [],
							usage: mapUsage(s.usage),
						})),
						response: event.response
							? {
									id: event.response.id,
									timestamp: event.response.timestamp
										? new Date(event.response.timestamp).toISOString()
										: undefined,
									modelId: event.response.modelId,
								}
							: undefined,
					});
				}
			: undefined,
	});

	return agent;
}

/** Map AI SDK usage to our normalized format */
function mapUsage(usage: any): StepFinishEvent["usage"] {
	if (!usage) {
		return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
	}
	return {
		promptTokens: usage.inputTokens ?? usage.promptTokens ?? 0,
		completionTokens: usage.outputTokens ?? usage.completionTokens ?? 0,
		totalTokens: usage.totalTokens ?? 0,
		inputTokenDetails: usage.inputTokenDetails
			? {
					noCacheTokens: usage.inputTokenDetails.noCacheTokens,
					cacheReadTokens: usage.inputTokenDetails.cacheReadTokens,
					cacheWriteTokens: usage.inputTokenDetails.cacheWriteTokens,
				}
			: undefined,
		outputTokenDetails: usage.outputTokenDetails
			? {
					textTokens: usage.outputTokenDetails.textTokens,
					reasoningTokens: usage.outputTokenDetails.reasoningTokens,
				}
			: undefined,
		raw: usage.raw,
	};
}

/**
 * Quick helper: run a single prompt through the agent and return the text result.
 */
export async function runAgent(
	config: EightAgentConfig,
	prompt: string,
): Promise<{ text: string; steps: number; usage: { totalTokens: number } }> {
	const agent = createEightAgent(config);
	const result = await agent.generate({ prompt });

	return {
		text: result.text,
		steps: result.steps?.length ?? 0,
		usage: {
			totalTokens: result.usage?.totalTokens ?? 0,
		},
	};
}

/** Thrown inside a tool's execute when the refusal gate refuses the call. */
export class ToolCallRefused extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ToolCallRefused";
	}
}

/**
 * Wrap every tool that executes so the gate runs first, inside execute, where
 * a refusal actually stops the call. Tools without execute are left as they
 * are. Returns new tool objects; the input set is not changed.
 */
export function gateTools<T extends ToolSet>(
	tools: T,
	gate: NonNullable<EightAgentConfig["gateToolCall"]>,
): T {
	const out: Record<string, unknown> = {};
	for (const [name, t] of Object.entries(tools)) {
		const execute = (
			t as { execute?: (input: unknown, options: { toolCallId: string }) => unknown }
		).execute;
		if (typeof execute !== "function") {
			out[name] = t;
			continue;
		}
		const check = async (input: unknown, options: { toolCallId: string }) => {
			const refusal = await gate({
				toolCallId: options?.toolCallId ?? "",
				toolName: name,
				args: (input ?? {}) as Record<string, unknown>,
			});
			if (refusal) throw new ToolCallRefused(refusal);
		};
		// A streaming tool (async generator) stays a generator, so the SDK still
		// sees its preliminary results; every other tool stays a plain promise.
		const streaming = execute.constructor?.name === "AsyncGeneratorFunction";
		out[name] = {
			...t,
			execute: streaming
				? async function* (input: unknown, options: { toolCallId: string }) {
						await check(input, options);
						yield* execute.call(t, input, options) as AsyncIterable<unknown>;
					}
				: async (input: unknown, options: { toolCallId: string }) => {
						await check(input, options);
						return execute.call(t, input, options);
					},
		};
	}
	return out as T;
}

/** A steering message and where it sits in the SDK's own step messages. */
export interface SteerEntry {
	at: number;
	message: ModelMessage;
}

/**
 * Steering for the native loop (D1). The SDK rebuilds each step's messages as
 * the run's input plus every response so far, and a `messages` override from
 * prepareStep holds for that step only. So the log keeps each steer with the
 * position it was first inserted at (always the end of the messages at that
 * step, after the tool results), and every later step splices them all back in
 * at the same places. Returns undefined when there is nothing to add.
 */
export function steerMessages(
	log: SteerEntry[],
	stepNumber: number,
	messages: ModelMessage[],
	drain: () => string[],
): ModelMessage[] | undefined {
	if (stepNumber === 0) log.length = 0;
	else {
		for (const content of drain()) {
			log.push({ at: messages.length, message: { role: "user", content } });
		}
	}
	if (log.length === 0) return undefined;
	const out = messages.slice();
	// Ascending positions, each against the messages without steers: offset by
	// the steers already placed in front of it.
	log.forEach((entry, i) => out.splice(entry.at + i, 0, entry.message));
	return out;
}
