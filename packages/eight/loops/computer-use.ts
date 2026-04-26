// 8gi:200-exempt -- core cua loop, decomposing further hurts readability
/**
 * Standard computer-use loop: perceive -> recall -> decide -> act -> repeat.
 *
 * - Perception defaults to the accessibility tree (cheap). The model can
 *   request a screenshot when the tree is insufficient.
 * - The loop integrates the channel-aware failover chain so the active
 *   model resolves to the vision/tool tier (Qwen 3.6-27B) by default.
 * - Acts strictly through `executeHandsTool` so the NemoClaw policy gate
 *   is never bypassed. Headless callers still see the policy contract.
 * - Terminates on `goal_complete`, `goal_failed`, or `maxSteps`.
 *
 * Recall is intentionally simple in v0: a stub that returns the last
 * step result so the perceive payload always includes "what just
 * happened". A future revision wires in `packages/memory/store.ts`.
 */

import {
	type HandsToolCtx,
	executeHandsTool,
	getHandsToolDefinitions,
} from "../../daemon/tools/hands";
import { type FailoverEntry, ModelFailover } from "../../providers/failover";
import { createClient } from "../clients";
import {
	type ScreenshotPerception,
	captureScreenshot,
} from "../perception/screenshot";
import {
	type AxNode,
	type TokenCost,
	type TreePerception,
	perceiveTree,
	summarizeTree,
} from "../perception/tree";
import { buildComputerUseSystemPrompt } from "../prompts/computer-use-system";
import { buildVisionPrompt } from "../prompts/computer-use-vision";
import type { Message } from "../types";
import type { LLMClient } from "../types";

/**
 * Optional adapter for headless environments (CI, smoke suite) that lets
 * the caller replace the daemon-side hands call. Production never sets
 * this; the loop falls through to `executeHandsTool` which goes through
 * the NemoClaw policy gate.
 */
export type HandsAdapter = (
	toolName: string,
	args: Record<string, unknown>,
	ctx: HandsToolCtx,
) => Promise<{ ok: true; result: unknown } | { ok: false; reason: string }>;

export interface CuaLoopConfig {
	goal: string;
	maxSteps?: number;
	/** Identifier used by the daemon's policy ctx + memory keys. */
	sessionId: string;
	/** Approval bridge for require_approval tool calls. Passed straight through. */
	approve?: HandsToolCtx["approve"];
	/** Optional host-info string surfaced to the system prompt. */
	hostInfo?: string;
	/** Pinned model. Defaults to the channel resolver's choice. */
	pinnedModel?: string;
	/** Inject a fake LLM client (used by the smoke suite). */
	clientFactory?: (entry: FailoverEntry) => LLMClient;
	/** Inject a fake failover (used by the smoke suite). */
	failover?: ModelFailover;
	/** Replace the daemon hands executor (CI/smoke only). */
	handsAdapter?: HandsAdapter;
}

export type CuaTerminationReason =
	| "goal_complete"
	| "goal_failed"
	| "max_steps"
	| "internal_error";

export interface CuaStepRecord {
	step: number;
	perception: TreePerception | ScreenshotPerception;
	perceptionMethod: "tree" | "screenshot";
	cost: TokenCost;
	toolName: string;
	toolArgs: Record<string, unknown>;
	resultPreview: string;
	approved: boolean;
	durationMs: number;
}

export interface CuaLoopResult {
	ok: boolean;
	reason: CuaTerminationReason;
	steps: CuaStepRecord[];
	finalMessage?: string;
	totalCost: number;
}

const DEFAULT_MAX_STEPS = 25;
const TERMINAL_TOOLS = new Set(["goal_complete", "goal_failed"]);

/**
 * Build the synthetic goal_complete / goal_failed tool definitions.
 * These are agent-only; they never reach the daemon.
 */
function getTerminationToolDefinitions(): object[] {
	return [
		{
			type: "function",
			function: {
				name: "goal_complete",
				description: "Call when the goal is met. The loop stops.",
				parameters: {
					type: "object",
					properties: {
						summary: {
							type: "string",
							description: "One-sentence summary of what was done.",
						},
					},
					required: ["summary"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "goal_failed",
				description: "Call when the goal cannot be met. The loop stops.",
				parameters: {
					type: "object",
					properties: {
						reason: {
							type: "string",
							description: "Plain-language blocker description.",
						},
					},
					required: ["reason"],
				},
			},
		},
	];
}

/**
 * Stub `recall` step. v0 just summarizes the prior tool result; a future
 * revision queries `packages/memory/store.ts` for similar past goals.
 */
function recall(history: CuaStepRecord[]): string {
	if (history.length === 0) return "";
	const last = history[history.length - 1];
	return `${last.toolName} -> ${last.resultPreview}`;
}

/**
 * Decide whether the agent's previous step asked us to escalate to a
 * screenshot on the next turn. The signal is a request to call
 * `desktop_screenshot`; until that fires we stay tree-first.
 */
function nextPerceptionMethod(history: CuaStepRecord[]): "tree" | "screenshot" {
	if (history.length === 0) return "tree";
	const last = history[history.length - 1];
	return last.toolName === "desktop_screenshot" ? "screenshot" : "tree";
}

/**
 * Translate a tool call result into a one-line preview for the next prompt.
 */
function previewResult(result: unknown): string {
	if (result === undefined || result === null) return "(no result)";
	try {
		const s = typeof result === "string" ? result : JSON.stringify(result);
		return s.length > 200 ? `${s.slice(0, 200)}...` : s;
	} catch {
		return String(result);
	}
}

/**
 * Encode a screenshot as a data URL the vision tier can ingest.
 * Returns undefined if the file is not readable; the loop falls back to
 * a tree-only message in that case.
 */
async function screenshotToDataUrl(path: string): Promise<string | undefined> {
	try {
		const file = Bun.file(path);
		const buf = await file.arrayBuffer();
		const base64 = Buffer.from(buf).toString("base64");
		return `data:image/png;base64,${base64}`;
	} catch {
		return undefined;
	}
}

function summarizePerception(p: TreePerception | ScreenshotPerception): string {
	if (p.kind === "tree") {
		if (!p.ok) return `tree-error: ${p.error ?? "unknown"}`;
		const head = p.appName
			? `${p.appName} -- ${p.windowTitle ?? ""}`
			: "(focused window)";
		return `${head}\n${summarizeTree(p.root, 60)}`;
	}
	if (!p.ok) return `screenshot-error: ${p.error ?? "unknown"}`;
	return `screenshot saved at ${p.path}; coord-map attached`;
}

/**
 * Resolve the active client for the current step. The cua loop only ever
 * runs on the `computer` channel, so the resolver picks the vision/tool
 * tier or its fallback.
 */
function resolveClient(
	failover: ModelFailover,
	pinnedModel: string,
	factory?: (entry: FailoverEntry) => LLMClient,
): { client: LLMClient; entry: FailoverEntry } {
	const entry = failover.resolve(pinnedModel, "computer");
	if (factory) return { client: factory(entry), entry };
	const runtime:
		| "ollama"
		| "deepseek"
		| "openrouter"
		| "apple-foundation"
		| "apfel" =
		entry.provider === "apfel"
			? "apfel"
			: entry.provider === "apple-foundation"
				? "apple-foundation"
				: entry.provider === "deepseek"
					? "deepseek"
					: entry.provider === "openrouter"
						? "openrouter"
						: "ollama";
	const client = createClient({ model: entry.model, runtime });
	return { client, entry };
}

/**
 * Run the loop. Returns when the agent terminates or the step ceiling
 * trips. The runner is responsible for streaming `CuaStepRecord`s out;
 * v0 collects them in an array and returns at the end.
 */
export async function runComputerUseLoop(
	config: CuaLoopConfig,
): Promise<CuaLoopResult> {
	const maxSteps = config.maxSteps ?? DEFAULT_MAX_STEPS;
	const failover = config.failover ?? new ModelFailover();
	const pinnedModel = config.pinnedModel ?? "qwen3.6:27b";

	const ctx: HandsToolCtx = {
		sessionId: config.sessionId,
		approve: config.approve,
	};
	const hands = config.handsAdapter ?? executeHandsTool;
	const tools = [
		...getHandsToolDefinitions(),
		...getTerminationToolDefinitions(),
	];

	const systemPrompt = buildComputerUseSystemPrompt({
		goal: config.goal,
		maxSteps,
		hostInfo: config.hostInfo,
	});

	const history: CuaStepRecord[] = [];
	let lastActionResult = "";
	let totalCost = 0;

	for (let step = 1; step <= maxSteps; step += 1) {
		const t0 = Date.now();
		const method = nextPerceptionMethod(history);

		let perception: TreePerception | ScreenshotPerception;
		if (method === "screenshot") {
			perception = await captureScreenshot({ ctx, hands });
		} else {
			perception = await perceiveTree({ ctx, hands });
		}

		// If the tree path failed (e.g. AX permission denied), fall back to a
		// screenshot rather than burning a step on perception failure.
		if (perception.kind === "tree" && !perception.ok) {
			perception = await captureScreenshot({ ctx, hands });
		}

		totalCost += perception.cost.tokens;
		const summary = summarizePerception(perception);

		let screenshotDataUrl: string | undefined;
		if (perception.kind === "screenshot" && perception.ok && perception.path) {
			screenshotDataUrl = await screenshotToDataUrl(perception.path);
		}

		const userMessage = buildVisionPrompt({
			goal: config.goal,
			step,
			maxSteps,
			perceptionSummary: summary,
			screenshotDataUrl,
			lastActionResult: [recall(history), lastActionResult]
				.filter(Boolean)
				.join(" | "),
		});

		const { client, entry } = resolveClient(
			failover,
			pinnedModel,
			config.clientFactory,
		);

		let llmResp: Awaited<ReturnType<LLMClient["chat"]>>;
		try {
			llmResp = await client.chat(
				[{ role: "system", content: systemPrompt }, userMessage],
				tools,
			);
		} catch (err) {
			// Mark this entry down and let the next iteration pick the next tier.
			failover.markDown(entry.model, entry.provider);
			lastActionResult = `model error on ${entry.provider}/${entry.model}: ${(err as Error).message}`;
			history.push({
				step,
				perception,
				perceptionMethod: method,
				cost: perception.cost,
				toolName: "_model_error",
				toolArgs: {},
				resultPreview: lastActionResult,
				approved: false,
				durationMs: Date.now() - t0,
			});
			continue;
		}

		const toolCall = llmResp.message.tool_calls?.[0];
		if (!toolCall) {
			// No tool call: treat free-text reply as a soft completion only if it
			// looks decisive; otherwise loop another turn with a nudge.
			const text = (llmResp.message.content ?? "").trim();
			lastActionResult = `model replied without tool: ${text.slice(0, 120)}`;
			history.push({
				step,
				perception,
				perceptionMethod: method,
				cost: perception.cost,
				toolName: "_no_tool",
				toolArgs: {},
				resultPreview: lastActionResult,
				approved: false,
				durationMs: Date.now() - t0,
			});
			continue;
		}

		const toolName = toolCall.function.name;
		let toolArgs: Record<string, unknown> = {};
		try {
			toolArgs = toolCall.function.arguments
				? typeof toolCall.function.arguments === "string"
					? JSON.parse(toolCall.function.arguments)
					: toolCall.function.arguments
				: {};
		} catch {
			toolArgs = {};
		}

		if (TERMINAL_TOOLS.has(toolName)) {
			const finalMessage = String(toolArgs.summary ?? toolArgs.reason ?? "");
			history.push({
				step,
				perception,
				perceptionMethod: method,
				cost: perception.cost,
				toolName,
				toolArgs,
				resultPreview: finalMessage,
				approved: true,
				durationMs: Date.now() - t0,
			});
			return {
				ok: toolName === "goal_complete",
				reason: toolName === "goal_complete" ? "goal_complete" : "goal_failed",
				steps: history,
				finalMessage,
				totalCost,
			};
		}

		const exec = await hands(toolName, toolArgs, ctx);
		const approved = exec.ok;
		const preview = exec.ok
			? previewResult(exec.result)
			: `[denied] ${exec.reason}`;
		lastActionResult = preview;
		history.push({
			step,
			perception,
			perceptionMethod: method,
			cost: perception.cost,
			toolName,
			toolArgs,
			resultPreview: preview,
			approved,
			durationMs: Date.now() - t0,
		});
	}

	return {
		ok: false,
		reason: "max_steps",
		steps: history,
		finalMessage: `Loop exited cleanly after ${maxSteps} steps without goal_complete.`,
		totalCost,
	};
}

// Re-exports kept narrow so callers don't reach into the perception layer.
export type { AxNode };
