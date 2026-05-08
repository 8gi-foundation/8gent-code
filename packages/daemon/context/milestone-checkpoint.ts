/**
 * MilestoneCheckpointer - decides when to compress.
 *
 * Two trigger sources:
 *   1. Token pressure: ContextTracker says we're near the window limit.
 *   2. Natural breakpoints: a tool succeeds, a file is saved, a test passes,
 *      or the caller signals "task complete". These are emitted by the
 *      daemon's event bus or by callers explicitly.
 *
 * The checkpointer keeps a chain of summaries (one per checkpoint) so each
 * compression pass can be incremental rather than regenerating the world.
 * Only the most recent summary is fed back into the engine; the rest are
 * archived for debugging.
 */

import type { ArtifactRegistryStore } from "./artifact-registry";
import type { CompressionEngine } from "./compression-engine";
import { buildCompressionInput } from "./compression-engine";
import type { ContextTracker } from "./context-tracker";
import type { Message, MilestoneCheckpoint, MilestoneEvent } from "./types";

export interface MilestoneCheckpointerOptions {
	/** Token-pressure threshold (0-1). Default 0.75 of context window. */
	nearLimitThreshold?: number;
	/**
	 * Minimum messages added since the previous checkpoint before a milestone
	 * event will trigger another. Prevents thrashing on rapid-fire tool
	 * successes.
	 */
	minMessagesBetweenCheckpoints?: number;
}

export interface CheckpointAttempt {
	checkpointed: boolean;
	reason: "near-limit" | "milestone" | "manual" | "none";
	checkpoint?: MilestoneCheckpoint;
	messages?: Message[];
}

const DEFAULT_NEAR_LIMIT = 0.75;
const DEFAULT_MIN_MESSAGES_BETWEEN = 8;

export class MilestoneCheckpointer {
	private engine: CompressionEngine;
	private tracker: ContextTracker;
	private registry: ArtifactRegistryStore;
	private summaries: string[] = [];
	private checkpoints: MilestoneCheckpoint[] = [];
	private pendingMilestone: MilestoneEvent | null = null;
	private messagesAtLastCheckpoint = 0;
	private options: Required<MilestoneCheckpointerOptions>;

	constructor(
		engine: CompressionEngine,
		tracker: ContextTracker,
		registry: ArtifactRegistryStore,
		options: MilestoneCheckpointerOptions = {},
	) {
		this.engine = engine;
		this.tracker = tracker;
		this.registry = registry;
		this.options = {
			nearLimitThreshold: options.nearLimitThreshold ?? DEFAULT_NEAR_LIMIT,
			minMessagesBetweenCheckpoints:
				options.minMessagesBetweenCheckpoints ?? DEFAULT_MIN_MESSAGES_BETWEEN,
		};
	}

	/** Caller signals a natural breakpoint. Compression may run on the next check. */
	recordEvent(event: MilestoneEvent): void {
		this.pendingMilestone = event;
	}

	/**
	 * Decide whether to checkpoint and (if so) run a compression pass.
	 * Returns the new message array on success; otherwise leaves messages
	 * untouched.
	 */
	async maybeCheckpoint(messages: Message[]): Promise<CheckpointAttempt> {
		const reason = this.decide(messages);
		if (reason === "none") {
			return { checkpointed: false, reason };
		}

		const previousSummary = this.summaries[this.summaries.length - 1] ?? null;
		const input = buildCompressionInput(messages, previousSummary, this.registry);
		const output = await this.engine.compress(input);

		// Compression was a no-op (e.g. nothing old enough to compress yet).
		if (output.messagesRemoved === 0) {
			this.pendingMilestone = null;
			return { checkpointed: false, reason };
		}

		const checkpoint: MilestoneCheckpoint = {
			id: makeCheckpointId(),
			createdAt: Date.now(),
			trigger: reason,
			event: this.pendingMilestone ?? undefined,
			tokensBefore: output.tokensBefore,
			tokensAfter: output.tokensAfter,
			messagesRemoved: output.messagesRemoved,
			summary: output.summary,
		};

		this.summaries.push(output.summary);
		this.checkpoints.push(checkpoint);
		this.messagesAtLastCheckpoint = output.messages.length;
		this.pendingMilestone = null;
		this.tracker.resetTo(output.messages);

		return {
			checkpointed: true,
			reason,
			checkpoint,
			messages: output.messages,
		};
	}

	/** Run an unconditional checkpoint regardless of triggers. */
	async forceCheckpoint(messages: Message[]): Promise<CheckpointAttempt> {
		this.pendingMilestone = this.pendingMilestone ?? { type: "manual", description: "force" };
		const previousSummary = this.summaries[this.summaries.length - 1] ?? null;
		const input = buildCompressionInput(messages, previousSummary, this.registry);
		const output = await this.engine.compress(input);
		const checkpoint: MilestoneCheckpoint = {
			id: makeCheckpointId(),
			createdAt: Date.now(),
			trigger: "manual",
			event: this.pendingMilestone ?? undefined,
			tokensBefore: output.tokensBefore,
			tokensAfter: output.tokensAfter,
			messagesRemoved: output.messagesRemoved,
			summary: output.summary,
		};
		this.summaries.push(output.summary);
		this.checkpoints.push(checkpoint);
		this.messagesAtLastCheckpoint = output.messages.length;
		this.pendingMilestone = null;
		this.tracker.resetTo(output.messages);
		return {
			checkpointed: output.messagesRemoved > 0,
			reason: "manual",
			checkpoint,
			messages: output.messages,
		};
	}

	getCheckpoints(): MilestoneCheckpoint[] {
		return [...this.checkpoints];
	}

	getLatestSummary(): string | null {
		return this.summaries[this.summaries.length - 1] ?? null;
	}

	private decide(messages: Message[]): CheckpointAttempt["reason"] {
		if (this.tracker.isNearLimit(this.options.nearLimitThreshold)) {
			return "near-limit";
		}
		if (this.pendingMilestone) {
			const newMessages = messages.length - this.messagesAtLastCheckpoint;
			if (newMessages >= this.options.minMessagesBetweenCheckpoints) {
				return "milestone";
			}
		}
		return "none";
	}
}

function makeCheckpointId(): string {
	return `ckpt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
