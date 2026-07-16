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

import { type HarnessRegistry, type StatusEvent, createDefaultRegistry } from "./index";

export interface RunInput {
	prompt: string;
	harness?: string;
	cwd?: string;
}

/** Cap on retained tasks so a long-lived daemon does not grow unbounded. */
const MAX_RETAINED_TASKS = 200;

export class HarnessRunner {
	readonly registry: HarnessRegistry;
	private tasks = new Map<string, StatusEvent[]>();
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
		const harness = this.registry.get(input.harness);
		const taskId = `hx_${Date.now().toString(36)}_${(this.counter++).toString(36)}`;
		this.tasks.set(taskId, []);
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
		this.tasks.get(event.agentId)?.push(event);
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
		}
	}
}
