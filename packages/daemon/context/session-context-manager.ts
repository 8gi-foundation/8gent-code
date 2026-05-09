/**
 * SessionContextManager - per-session bundle of context infrastructure.
 *
 * One instance per AgentPool session. Holds:
 *   - ContextTracker (token usage)
 *   - ArtifactRegistryStore (never-compressed file/entity/decision index)
 *   - CompressionEngine (LLM-driven incremental summarizer)
 *   - MilestoneCheckpointer (decides when to compress, runs the engine)
 *
 * The AgentPool calls `recordExchange()` after each chat turn to feed the
 * tracker, then calls `maybeCompress(messages)` to let the checkpointer
 * decide whether to run. If it does, the new message array is returned and
 * the caller is expected to push it back into the agent via
 * `agent.restoreFromCheckpoint(...)`.
 */

import { ArtifactRegistryStore } from "./artifact-registry";
import { CompressionEngine, type SummarizerCall } from "./compression-engine";
import { ContextTracker } from "./context-tracker";
import { type CheckpointAttempt, MilestoneCheckpointer } from "./milestone-checkpoint";
import type { Message, MilestoneEvent } from "./types";

export interface SessionContextManagerOptions {
	contextWindow?: number;
	nearLimitThreshold?: number;
	keepRecentTokens?: number;
	maxSummaryTokens?: number;
	minMessagesBetweenCheckpoints?: number;
	summarize: SummarizerCall;
}

export class SessionContextManager {
	readonly tracker: ContextTracker;
	readonly registry: ArtifactRegistryStore;
	readonly engine: CompressionEngine;
	readonly checkpointer: MilestoneCheckpointer;

	constructor(options: SessionContextManagerOptions) {
		this.tracker = new ContextTracker({
			contextWindow: options.contextWindow,
		});
		this.registry = new ArtifactRegistryStore();
		this.engine = new CompressionEngine(options.summarize, {
			keepRecentTokens: options.keepRecentTokens,
			maxSummaryTokens: options.maxSummaryTokens,
		});
		this.checkpointer = new MilestoneCheckpointer(this.engine, this.tracker, this.registry, {
			nearLimitThreshold: options.nearLimitThreshold,
			minMessagesBetweenCheckpoints: options.minMessagesBetweenCheckpoints,
		});
	}

	recordExchange(promptTokens: number, completionTokens: number): void {
		this.tracker.recordExchange(promptTokens, completionTokens);
	}

	recordMilestone(event: MilestoneEvent): void {
		this.checkpointer.recordEvent(event);
	}

	ingestMessage(message: Message): void {
		this.registry.ingestMessage(message);
	}

	ingestMessages(messages: Message[]): void {
		this.registry.ingestMessages(messages);
	}

	/**
	 * Walk the agent's message history and pull artifacts out, then ask the
	 * checkpointer whether it's time to compress.
	 *
	 * Returns the attempt result. If `checkpointed` is true the caller should
	 * apply `attempt.messages` back to the agent.
	 */
	async maybeCompress(messages: Message[]): Promise<CheckpointAttempt> {
		this.ingestMessages(messages);
		return this.checkpointer.maybeCheckpoint(messages);
	}

	getStatus(): {
		tracker: ReturnType<ContextTracker["getUsage"]>;
		registry: ReturnType<ArtifactRegistryStore["stats"]>;
		checkpoints: number;
	} {
		return {
			tracker: this.tracker.getUsage(),
			registry: this.registry.stats(),
			checkpoints: this.checkpointer.getCheckpoints().length,
		};
	}
}
