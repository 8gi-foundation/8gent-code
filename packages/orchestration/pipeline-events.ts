/**
 * pipeline-events.ts - a typed, synchronous event bus for the adaptive pipeline.
 *
 * The pipeline's deterministic brain (Obstacle -> Severity -> Decision) emits a
 * stream of structured PipelineEvents. Anything can subscribe: a TUI log line,
 * the nightly ledger, and - the motivating case - 8gent Flow over HTTP, so a
 * human can watch a build live and drop in instructions mid-flight.
 *
 * This upgrades the old `onProgress(string)` log to structured events while
 * still being able to render a single human log line per event.
 */

import type { PipelineEvent, PipelineEventSink } from "./pipeline-contracts.js";

/** Options for wiring a bus to a Flow relay and/or a plain-line logger. */
export interface PipelineEventBusOptions {
	/** Optional URL to fire-and-forget POST each event to (e.g. the Flow relay). */
	httpSink?: string;
	/** Optional plain-line callback - the structured -> string bridge. */
	onLine?: (line: string) => void;
}

export class PipelineEventBus {
	private readonly sinks = new Set<PipelineEventSink>();
	private readonly httpSink?: string;
	private readonly onLine?: (line: string) => void;

	/**
	 * In-flight HTTP POSTs. Tests (and graceful shutdown) can `await
	 * Promise.all(bus.pending)` to make delivery deterministic. The bus itself
	 * never awaits these - emit stays synchronous and non-blocking.
	 */
	readonly pending: Promise<void>[] = [];

	constructor(opts?: PipelineEventBusOptions) {
		this.httpSink = opts?.httpSink;
		this.onLine = opts?.onLine;
	}

	/**
	 * Register a sink. Returns an unsubscribe function; calling it removes the
	 * sink so it stops receiving events.
	 */
	subscribe(sink: PipelineEventSink): () => void {
		this.sinks.add(sink);
		return () => {
			this.sinks.delete(sink);
		};
	}

	/**
	 * Synchronously deliver an event to every subscriber, the line callback, and
	 * (fire-and-forget) the HTTP sink. A throwing sink is caught so one bad
	 * subscriber can never break delivery to the others or the pipeline.
	 */
	emit(event: PipelineEvent): void {
		for (const sink of this.sinks) {
			try {
				sink(event);
			} catch {
				// A subscriber must never break emit. Swallow and continue.
			}
		}

		if (this.onLine) {
			try {
				this.onLine(toProgressLine(event));
			} catch {
				// The line bridge is best-effort too.
			}
		}

		if (this.httpSink) {
			this.pending.push(this.postEvent(this.httpSink, event));
		}
	}

	/**
	 * Fire-and-forget POST of one event as JSON. Bounded by a ~3s AbortController
	 * timeout and swallows ALL errors - it must never throw or block the pipeline.
	 */
	private async postEvent(url: string, event: PipelineEvent): Promise<void> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 3000);
		try {
			await fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(event),
				signal: controller.signal,
			});
		} catch {
			// Network failure, abort, bad URL - none of it should reach the pipeline.
		} finally {
			clearTimeout(timer);
		}
	}
}

/**
 * Render any PipelineEvent variant as a concise, human-readable log line.
 * Covers every PipelineEvent.kind so callers can keep a single text log.
 */
export function toProgressLine(event: PipelineEvent): string {
	switch (event.kind) {
		case "stage": {
			const model = event.model ? ` (${event.model})` : "";
			const detail = event.detail ? ` - ${event.detail}` : "";
			return `stage:${event.status} ${event.stage}${model}${detail}`;
		}
		case "unit": {
			const model = event.model ? ` (${event.model})` : "";
			return `unit:${event.status} ${event.path}${model}`;
		}
		case "obstacle":
			return `obstacle[${event.severity}] ${event.stage}: ${event.obstacle}`;
		case "decision":
			return `decision ${event.stage} -> ${event.strategy} (${event.rationale})`;
		case "escalate":
			return `escalate ${event.from} -> ${event.to} (${event.reason})`;
		case "instruction":
			return `instruction: ${event.text}`;
		case "done":
			return `done ${event.ok ? "ok" : "failed"}${event.artifact ? ` ${event.artifact}` : ""}`;
		default: {
			// Exhaustiveness guard: if PipelineEvent gains a kind, this won't compile.
			const _never: never = event;
			return String(_never);
		}
	}
}
