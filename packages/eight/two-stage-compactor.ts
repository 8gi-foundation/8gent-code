/**
 * Two-Stage Context Compactor (issue #2467).
 *
 * Concept extracted from StartupHakk/OpenMonoAgent under CleanRoomPort rules;
 * no AGPL source copied. Behaviour was rebuilt from the issue acceptance
 * criteria, not from any external implementation.
 *
 * Two thresholds smooth the experience at the brink of the context window:
 *   1. checkpointPct (default 0.65): write a cheap LLM-generated summary
 *      alongside the live history. The message list is NOT modified, so
 *      future turns get the full tail plus a checkpoint summary prefix.
 *   2. compactPct (default 0.80): hard compact. Replace messages older than
 *      the last keepLastN with the most recent checkpoint summary. If no
 *      checkpoint exists yet (e.g. degenerate single-threshold config), one
 *      is generated on the fly.
 *
 * Both thresholds resolve against `state.provider.contextSize` so a 32K
 * provider triggers around 21K and 26K, not the hardcoded 200K of the
 * legacy CompactionEngine.
 *
 * The compactor is purely state-driven. It owns no clock, no LLM client,
 * and no I/O beyond the injected `summarizer`. That keeps it deterministic
 * for tests and cheap to call after every turn from agent.ts.
 *
 * @author podjamz
 */

export interface ProviderInfo {
	/** Maximum context window of the active provider, in tokens. */
	contextSize: number;
}

export interface AgentMessage {
	role: string;
	content: string;
}

export interface CheckpointEntry {
	/** LLM summary of the messages older than the live tail at the time of capture. */
	summary: string;
	/** Index in `messages` (exclusive) up to which the summary covers. */
	cutoffIndex: number;
	/** Token estimate for `messages` at the moment the checkpoint was taken. */
	tokensAtCapture: number;
}

export interface AgentState {
	messages: AgentMessage[];
	checkpoints: CheckpointEntry[];
	provider: ProviderInfo;
}

export type Summarizer = (
	messages: AgentMessage[],
	context: { previousSummary: string | null },
) => Promise<string>;

export interface TwoStageOptions {
	/** Trigger fraction for the cheap checkpoint stage. Default 0.65. */
	checkpointPct?: number;
	/** Trigger fraction for hard compaction. Default 0.80. */
	compactPct?: number;
	/** Number of trailing messages to always keep verbatim. Default 4. */
	keepLastN?: number;
	/** Async function that produces a checkpoint summary. */
	summarizer: Summarizer;
}

export interface CompactionReport {
	tokensBefore: number;
	tokensAfter: number;
	messagesRemoved: number;
	summary: string;
}

export type CompactionAction = "none" | "checkpoint" | "compact";

export interface ObserveResult {
	action: CompactionAction;
	report?: CompactionReport;
}

const DEFAULT_CHECKPOINT_PCT = 0.65;
const DEFAULT_COMPACT_PCT = 0.8;
const DEFAULT_KEEP_LAST_N = 4;
const PER_MESSAGE_OVERHEAD = 4;
const CHARS_PER_TOKEN = 4;

function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateMessageTokens(messages: AgentMessage[]): number {
	let total = 0;
	for (const m of messages) total += estimateTokens(m.content) + PER_MESSAGE_OVERHEAD;
	return total;
}

/**
 * Two-stage compactor. Call `observe(state)` after each agent turn. Returns
 * the action taken; mutates `state.messages` only when action is 'compact',
 * and always appends to `state.checkpoints` when checkpointing.
 */
export class TwoStageCompactor {
	private readonly checkpointPct: number;
	private readonly compactPct: number;
	private readonly keepLastN: number;
	private readonly summarizer: Summarizer;

	/**
	 * Tracks whether we've already written a checkpoint for the current
	 * crossing of the checkpoint threshold. Reset whenever usage drops back
	 * below the threshold so a later re-crossing produces a fresh checkpoint.
	 */
	private checkpointTakenForCurrentCrossing = false;

	constructor(opts: TwoStageOptions) {
		this.checkpointPct = opts.checkpointPct ?? DEFAULT_CHECKPOINT_PCT;
		this.compactPct = opts.compactPct ?? DEFAULT_COMPACT_PCT;
		this.keepLastN = Math.max(1, opts.keepLastN ?? DEFAULT_KEEP_LAST_N);
		this.summarizer = opts.summarizer;

		if (this.checkpointPct < 0 || this.checkpointPct > 1) {
			throw new Error(`checkpointPct must be in [0,1], got ${this.checkpointPct}`);
		}
		if (this.compactPct < 0 || this.compactPct > 1) {
			throw new Error(`compactPct must be in [0,1], got ${this.compactPct}`);
		}
		if (this.compactPct < this.checkpointPct) {
			throw new Error(
				`compactPct (${this.compactPct}) must be >= checkpointPct (${this.checkpointPct})`,
			);
		}
	}

	/**
	 * Inspect the current state and act if the relevant threshold is crossed.
	 *
	 * Order of evaluation:
	 *   - Compact threshold wins over checkpoint when both are crossed.
	 *   - Single-threshold config (checkpointPct === compactPct) skips the
	 *     checkpoint stage entirely.
	 *   - When the checkpoint stage runs, it is at most once per crossing.
	 */
	async observe(state: AgentState): Promise<ObserveResult> {
		const ctx = state.provider.contextSize;
		if (!ctx || ctx <= 0) return { action: "none" };

		const used = estimateMessageTokens(state.messages);
		const ratio = used / ctx;

		// Reset crossing flag if usage dropped back under the checkpoint line.
		if (ratio < this.checkpointPct) {
			this.checkpointTakenForCurrentCrossing = false;
			return { action: "none" };
		}

		if (ratio >= this.compactPct) {
			return this.runCompact(state, used);
		}

		// Between thresholds — checkpoint at most once per crossing. In a
		// degenerate single-threshold config, checkpointPct === compactPct so
		// this branch never fires (the compact branch above wins).
		if (this.checkpointPct < this.compactPct && !this.checkpointTakenForCurrentCrossing) {
			return this.runCheckpoint(state, used);
		}

		return { action: "none" };
	}

	private async runCheckpoint(state: AgentState, tokensBefore: number): Promise<ObserveResult> {
		const cutoffIndex = this.computeCutoffIndex(state.messages);
		// Skip system message at index 0; summarise everything between system
		// and the live tail.
		const startIdx = state.messages.length > 0 && state.messages[0].role === "system" ? 1 : 0;
		const toSummarise = state.messages.slice(startIdx, cutoffIndex);
		if (toSummarise.length === 0) {
			// Nothing to summarise yet; mark crossing handled so we don't
			// thrash the summariser on every turn at the boundary.
			this.checkpointTakenForCurrentCrossing = true;
			return { action: "none" };
		}

		const previousSummary = state.checkpoints.at(-1)?.summary ?? null;
		const summary = await this.summarizer(toSummarise, { previousSummary });

		state.checkpoints.push({
			summary,
			cutoffIndex,
			tokensAtCapture: tokensBefore,
		});
		this.checkpointTakenForCurrentCrossing = true;

		return {
			action: "checkpoint",
			report: {
				tokensBefore,
				tokensAfter: tokensBefore,
				messagesRemoved: 0,
				summary,
			},
		};
	}

	private async runCompact(state: AgentState, tokensBefore: number): Promise<ObserveResult> {
		const hasSystem = state.messages.length > 0 && state.messages[0].role === "system";
		const systemMsg = hasSystem ? state.messages[0] : null;
		const startIdx = hasSystem ? 1 : 0;

		// Always keep the trailing keepLastN messages.
		const tailStart = Math.max(startIdx, state.messages.length - this.keepLastN);
		const tail = state.messages.slice(tailStart);
		const middle = state.messages.slice(startIdx, tailStart);

		// Reuse the most recent checkpoint summary when possible to honour the
		// "checkpoint-then-compact" flow; otherwise generate one now so a
		// degenerate single-threshold config still produces useful output.
		let summary = state.checkpoints.at(-1)?.summary ?? null;
		if (!summary) {
			const previousSummary = null;
			summary = await this.summarizer(middle, { previousSummary });
			state.checkpoints.push({
				summary,
				cutoffIndex: tailStart,
				tokensAtCapture: tokensBefore,
			});
		}

		const summaryMsg: AgentMessage = {
			role: "system",
			content: `[Two-Stage Compaction Summary]\n\n${summary}`,
		};
		const next: AgentMessage[] = [];
		if (systemMsg) next.push(systemMsg);
		next.push(summaryMsg, ...tail);

		const removed = state.messages.length - next.length;
		state.messages.length = 0;
		for (const m of next) state.messages.push(m);

		// Reset crossing flag — after compaction we're below the line again
		// and a future checkpoint should be allowed.
		this.checkpointTakenForCurrentCrossing = false;

		const tokensAfter = estimateMessageTokens(state.messages);
		return {
			action: "compact",
			report: {
				tokensBefore,
				tokensAfter,
				messagesRemoved: Math.max(0, removed),
				summary,
			},
		};
	}

	/**
	 * Index in `messages` (exclusive) up to which a checkpoint summary
	 * should cover. Anything from this index onward is "live tail" and is
	 * preserved verbatim.
	 */
	private computeCutoffIndex(messages: AgentMessage[]): number {
		const cutoff = Math.max(0, messages.length - this.keepLastN);
		return cutoff;
	}
}
