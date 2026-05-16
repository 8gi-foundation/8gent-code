/**
 * EightExecutor - real-backend Executor for the GoalLoop.
 *
 * Wraps the existing `packages/eight/agent.ts` Agent class so each call to
 * `.turn()` drives ONE conversational turn of the agent loop (one
 * `agent.chat(prompt)` invocation, which may itself fan out into N internal
 * tool-calling steps; that fan-out is opaque to the outer GoalLoop).
 *
 * Design notes (8TO):
 *   - ZERO edits to agent.ts. Wrap it; do not modify it.
 *   - Each `.turn()` constructs a fresh Agent. That keeps blast radius tight
 *     and prevents accidental shared state between turns. If we later want
 *     conversational continuity we layer a pool; today the goal-loop's
 *     `priorVerdict` + injected subgoal carry the needed context forward.
 *   - Token accounting comes from the per-step `usage` events that the
 *     existing agent already emits. We sum them into the turn output.
 *   - File / egress accounting is opportunistic — Agent doesn't track these
 *     directly. We surface a best-effort estimate (touched-files via the
 *     `Write`/`Edit`/`Delete` tool names we see on `onToolEnd`). The budget
 *     check in `goal-loop.ts` enforces caps regardless.
 *   - Abort is cooperative. `abort()` calls `agent.cleanup()` (which closes
 *     the abortController inside the Agent) AND flips an `aborted` flag so
 *     subsequent `.turn()` calls reject immediately. The in-flight `chat()`
 *     also unwinds via the Agent's own abortController.
 */

import type { Agent as AgentClass } from "../eight/agent";
import type {
	AgentConfig,
	AgentEventCallbacks,
	AgentStepEvent,
	AgentToolEndEvent,
} from "../eight/types";
import type {
	ExecutorHandle,
	ExecutorTurnInput,
	ExecutorTurnOutput,
} from "./types";

/**
 * Factory the executor uses to build an Agent. Defaulted to a dynamic import
 * of the real Agent class to keep this file unit-testable without dragging
 * the entire agent.ts surface into the test sandbox.
 */
export type AgentFactory = (config: AgentConfig) => Promise<AgentLike> | AgentLike;

/**
 * Narrowed view of the Agent surface the executor actually touches. Lets
 * tests pass a stub without implementing all 50+ methods on Agent.
 */
export interface AgentLike {
	chat(prompt: string, imageBase64?: string, imageMimeType?: string): Promise<string>;
	cleanup(): Promise<void>;
}

export interface EightExecutorOptions {
	/** Model id (e.g. "eight-1.0-q3:14b", "qwen3:14b", "apple-foundationmodel"). */
	model: string;
	/** Runtime for createClient. Mirrors AgentConfig.runtime. */
	runtime: AgentConfig["runtime"];
	/** Working directory for the agent. Defaults to process.cwd(). */
	workingDirectory?: string;
	/** Hard cap on internal agent steps per outer turn. Default 30. */
	maxStepsPerTurn?: number;
	/** Optional API key (forwarded to AgentConfig). */
	apiKey?: string;
	/** Optional channel hint ("text" | "computer"). */
	channel?: AgentConfig["channel"];
	/**
	 * Override the agent factory. Production callers leave this unset and we
	 * dynamically import the real Agent. Tests inject a stub.
	 */
	agentFactory?: AgentFactory;
}

const TOUCH_TOOL_NAMES = new Set([
	"Write",
	"write",
	"Edit",
	"edit",
	"MultiEdit",
	"multiedit",
	"Delete",
	"delete",
	"Move",
	"move",
	"FileWrite",
	"FileEdit",
]);

/** Default factory: dynamic import keeps agent.ts out of cold paths. */
async function defaultAgentFactory(config: AgentConfig): Promise<AgentLike> {
	const mod = await import("../eight/agent");
	const Agent: typeof AgentClass = mod.Agent;
	return new Agent(config) as AgentLike;
}

export class EightExecutor implements ExecutorHandle {
	readonly model: string;
	private readonly runtime: AgentConfig["runtime"];
	private readonly workingDirectory: string;
	private readonly maxStepsPerTurn: number;
	private readonly apiKey?: string;
	private readonly channel?: AgentConfig["channel"];
	private readonly agentFactory: AgentFactory;
	private aborted = false;
	private activeAgent: AgentLike | null = null;

	constructor(opts: EightExecutorOptions) {
		if (!opts.model?.trim()) {
			throw new Error("EightExecutor: model is required");
		}
		if (!opts.runtime) {
			throw new Error("EightExecutor: runtime is required");
		}
		this.model = opts.model;
		this.runtime = opts.runtime;
		this.workingDirectory = opts.workingDirectory ?? process.cwd();
		this.maxStepsPerTurn = opts.maxStepsPerTurn ?? 30;
		this.apiKey = opts.apiKey;
		this.channel = opts.channel;
		this.agentFactory = opts.agentFactory ?? defaultAgentFactory;
	}

	async turn(input: ExecutorTurnInput): Promise<ExecutorTurnOutput> {
		if (this.aborted) {
			throw new Error("EightExecutor: aborted");
		}

		const prompt = renderPrompt(input);

		// Per-turn accumulators. We sum across all internal agent steps so
		// the goal-loop sees one consolidated usage figure.
		let tokensIn = 0;
		let tokensOut = 0;
		const touchedFiles = new Set<string>();
		let lastStepText = "";

		const events: AgentEventCallbacks = {
			onStepFinish: (e: AgentStepEvent) => {
				tokensIn += e.usage?.promptTokens ?? 0;
				tokensOut += e.usage?.completionTokens ?? 0;
				if (e.text?.trim()) lastStepText = e.text;
			},
			onToolEnd: (e: AgentToolEndEvent) => {
				if (!TOUCH_TOOL_NAMES.has(e.toolName)) return;
				// Best-effort: pull a "path"/"file_path" arg if present.
				const args = e.args || {};
				const p =
					(typeof args.file_path === "string" && args.file_path) ||
					(typeof args.path === "string" && args.path) ||
					(typeof args.target === "string" && args.target) ||
					"";
				if (p) touchedFiles.add(p);
			},
		};

		const config: AgentConfig = {
			model: this.model,
			runtime: this.runtime,
			workingDirectory: this.workingDirectory,
			maxTurns: this.maxStepsPerTurn,
			apiKey: this.apiKey,
			channel: this.channel,
			events,
		};

		const agent = await this.agentFactory(config);
		this.activeAgent = agent;
		try {
			if (this.aborted) {
				throw new Error("EightExecutor: aborted before chat dispatch");
			}
			const finalText = await agent.chat(prompt);
			const summary = summarise(finalText, lastStepText);
			return {
				summary,
				tokensIn,
				tokensOut,
				filesChanged: touchedFiles.size || undefined,
			};
		} finally {
			this.activeAgent = null;
			// Always cleanup the per-turn agent. Cleanup is best-effort; do
			// not let teardown errors mask the underlying result.
			try {
				await agent.cleanup();
			} catch {
				// swallow - cleanup failures are not loop-fatal
			}
		}
	}

	abort(): void {
		this.aborted = true;
		const a = this.activeAgent;
		if (!a) return;
		// Fire-and-forget cleanup to unwind in-flight chat. Don't await -
		// the contract on ExecutorHandle.abort is synchronous.
		void Promise.resolve()
			.then(() => a.cleanup())
			.catch(() => undefined);
	}
}

/**
 * Compose the executor prompt from the loop's structured input. The outer
 * goal text always leads; subgoal (if injected) gets a clear header; prior
 * verdict notes are forwarded as judge guidance so the executor knows what
 * to fix next iteration.
 */
function renderPrompt(input: ExecutorTurnInput): string {
	const parts: string[] = [];
	parts.push(`GOAL (turn ${input.turn}):\n${input.goal.trim()}`);
	if (input.subgoal?.trim()) {
		parts.push(`SUBGOAL (injected this turn):\n${input.subgoal.trim()}`);
	}
	if (input.priorVerdict) {
		const v = input.priorVerdict;
		parts.push(
			`JUDGE VERDICT FROM PREVIOUS TURN:\n` +
				`  decision: ${v.decision}\n` +
				`  confidence: ${v.confidence.toFixed(2)}\n` +
				`  summary: ${v.summary}` +
				(v.nextStep ? `\n  nextStep: ${v.nextStep}` : ""),
		);
	}
	parts.push(
		"Take the next concrete step toward the goal. When the goal is fully done, " +
			"state that explicitly. No em dashes.",
	);
	return parts.join("\n\n");
}

/**
 * Build a short summary fed to the judge. We prefer the final text from
 * agent.chat() over the last onStepFinish text because tool-only steps
 * have empty text. Cap at 4000 chars; the judge prompt is the consumer.
 */
function summarise(finalText: string, lastStepText: string): string {
	const raw = (finalText?.trim() || lastStepText?.trim() || "").replace(/—/g, "-");
	if (raw.length <= 4000) return raw;
	return `${raw.slice(0, 3996)}...`;
}
