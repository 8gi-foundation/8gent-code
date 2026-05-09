/**
 * ContextTracker - per-session token usage tracking.
 *
 * Records cumulative input/output tokens recorded at the daemon boundary
 * (i.e. counted once per chat() call, not re-summed from messageHistory each
 * turn). Exposes a cheap `isNearLimit` check for the compression scheduler.
 *
 * This is intentionally separate from the agent's in-process token estimator
 * so that the daemon can keep a stable per-session reading even as the agent
 * itself compacts internally.
 */

import { countMessages, countTokens } from "../../tools/token-counter";
import type { ContextUsage, Message } from "./types";

const DEFAULT_CONTEXT_WINDOW = 32768;
const DEFAULT_NEAR_LIMIT_THRESHOLD = 0.75;

export interface ContextTrackerOptions {
	contextWindow?: number;
}

export class ContextTracker {
	private inputTokens = 0;
	private outputTokens = 0;
	private contextWindow: number;

	constructor(options: ContextTrackerOptions = {}) {
		this.contextWindow = options.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
	}

	recordInput(tokens: number): void {
		if (tokens < 0) return;
		this.inputTokens += tokens;
	}

	recordOutput(tokens: number): void {
		if (tokens < 0) return;
		this.outputTokens += tokens;
	}

	/** Convenience: record both input and output for a single exchange. */
	recordExchange(promptTokens: number, completionTokens: number): void {
		this.recordInput(promptTokens);
		this.recordOutput(completionTokens);
	}

	/**
	 * Reset the running counter to the size of the supplied message array.
	 * Used after compression so the tracker reflects the new in-window load.
	 */
	resetTo(messages: Message[]): void {
		this.inputTokens = countMessages(messages);
		this.outputTokens = 0;
	}

	getUsage(): ContextUsage {
		const total = this.inputTokens + this.outputTokens;
		const ratio = this.contextWindow > 0 ? total / this.contextWindow : 0;
		const remaining = Math.max(0, this.contextWindow - total);
		return {
			input: this.inputTokens,
			output: this.outputTokens,
			total,
			contextWindow: this.contextWindow,
			ratio,
			remaining,
		};
	}

	isNearLimit(threshold: number = DEFAULT_NEAR_LIMIT_THRESHOLD): boolean {
		return this.getUsage().ratio >= threshold;
	}

	getContextWindow(): number {
		return this.contextWindow;
	}

	setContextWindow(window: number): void {
		if (window <= 0) return;
		this.contextWindow = window;
	}
}

/**
 * Helper for callers who only have raw text (request body, response body) and
 * need a token estimate without instantiating a tracker.
 */
export function estimateExchangeTokens(
	prompt: string,
	completion: string,
): {
	prompt: number;
	completion: number;
	total: number;
} {
	const p = countTokens(prompt);
	const c = countTokens(completion);
	return { prompt: p, completion: c, total: p + c };
}
