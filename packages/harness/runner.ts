/**
 * HarnessRunner - task manager behind the harness HTTP surface (part of #2797).
 *
 * start() dispatches a task through the registry and returns a taskId
 * immediately; the run drains detached. Events are buffered per task (for
 * SSE replay / late readers) and fanned out live to subscribers.
 *
 * In-memory only by design: this slice is the streaming substrate, task
 * persistence across daemon restarts is out of scope (see SPEC.md).
 */

import { type Harness, type HarnessRegistry, type StatusEvent, createDefaultRegistry } from "./index";

export interface RunInput {
	prompt: string;
	harness?: string;
	cwd?: string;
}

/** Cap on retained tasks so a long-lived daemon does not grow unbounded. */
const MAX_RETAINED_TASKS = 200;

/**
 * Cap on retained events per task (#2810): a verbose external CLI must not
 * grow one task's buffered event array without bound. The first event
 * (queued) is preserved; the oldest progress events are dropped first, so
 * the terminal done/error event is always retained.
 */
const MAX_EVENTS_PER_TASK = 500;

export class HarnessRunner {
	readonly registry: HarnessRegistry;
	private tasks = new Map<string, StatusEvent[]>();
	private harnessByTask = new Map<string, Harness>();
	private listeners = new Set<(e: StatusEvent) => void>();
	private counter = 0;

	constructor(registry?: HarnessRegistry) {
		this.registry = registry ?? createDefaultRegistry();
	}

	/**
	 * Dispatch a task. Resolves the harness synchronously (unknown names throw
	 * before anything runs), then drains the run in the background.
	 */
	start(input: RunInput): string {
		// #2803: refuse to dispatch an empty/whitespace prompt at the runner seam
		// too (the HTTP layer 400s, but any direct caller must be equally safe).
		if (!input.prompt || !input.prompt.trim()) {
			throw new Error("prompt is required: refusing to dispatch an empty prompt (#2803)");
		}
		const harness = this.registry.get(input.harness);
		const taskId = `hx_${Date.now().toString(36)}_${(this.counter++).toString(36)}`;
		this.tasks.set(taskId, []);
		this.harnessByTask.set(taskId, harness);
		this.evictOldTasks();

		void (async () => {
			try {
				for await (const event of harness.run({
					id: taskId,
					prompt: input.prompt,
					cwd: input.cwd,
				})) {
					this.record(event);
				}
			} catch (err) {
				// A harness that throws mid-stream still terminates honestly.
				this.record({
					agentId: taskId,
					harness: harness.name,
					state: "error",
					output: err instanceof Error ? err.message : String(err),
					ts: Date.now(),
				});
			}
		})();

		return taskId;
	}

	/** Buffered event history for a task. [] when unknown. */
	getEvents(taskId: string): StatusEvent[] {
		return this.tasks.get(taskId) ?? [];
	}

	/**
	 * Deliver a follow-up input line to a task that reported needs_input
	 * (#2809). Routed to the owning harness's respond() when it has one.
	 * Returns true only when the input really reached the running task.
	 */
	respond(taskId: string, input: string): boolean {
		const harness = this.harnessByTask.get(taskId);
		if (!harness?.respond) return false;
		return harness.respond(taskId, input);
	}

	/** Live event feed across all tasks. Returns an unsubscribe function. */
	subscribe(listener: (e: StatusEvent) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** All buffered events across retained tasks, oldest task first. */
	allEvents(): StatusEvent[] {
		const out: StatusEvent[] = [];
		for (const events of this.tasks.values()) out.push(...events);
		return out;
	}

	private record(event: StatusEvent): void {
		const events = this.tasks.get(event.agentId);
		if (events) {
			// #2810: bound per-task retention. Keep the first event (queued),
			// drop the oldest progress event; the newest event always lands.
			if (events.length >= MAX_EVENTS_PER_TASK) events.splice(1, 1);
			events.push(event);
		}
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// One bad subscriber must not break the fan-out.
			}
		}
	}

	private evictOldTasks(): void {
		while (this.tasks.size > MAX_RETAINED_TASKS) {
			const oldest = this.tasks.keys().next().value;
			if (oldest === undefined) break;
			this.tasks.delete(oldest);
			this.harnessByTask.delete(oldest);
		}
	}
}
