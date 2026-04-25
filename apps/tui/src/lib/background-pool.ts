/**
 * TUI background task pool.
 *
 * Lightweight in-process registry of tasks the user has "sent to background"
 * via Ctrl+G. We don't intercept agent.chat(): the Promise keeps running on
 * its own. This module tracks metadata (label, status, timing, result) and
 * fires a listener callback when a task settles, so the foreground UI can
 * surface a non-modal completion banner.
 *
 * Scope (issue #1795, Rank 4):
 * - In-process only. No daemon coupling.
 * - No cancellation. The task runs to completion wherever it was started.
 * - No persistence across TUI restarts. Best-effort UX helper.
 */
export type BgStatus = "running" | "done" | "error";

export interface BgTask {
	id: string;
	label: string;
	status: BgStatus;
	startedAt: number;
	finishedAt?: number;
	resultPreview?: string;
	error?: string;
}

type Listener = (task: BgTask) => void;

const tasks = new Map<string, BgTask>();
const listeners = new Set<Listener>();
let seq = 0;

function notify(task: BgTask) {
	for (const fn of listeners) {
		try {
			fn(task);
		} catch {
			// listeners must never break pool state
		}
	}
}

/** Begin tracking a running task. Returns an id used to settle it later. */
export function track(label: string, promise: Promise<string>): string {
	const id = `bg-${Date.now()}-${++seq}`;
	const task: BgTask = {
		id,
		label: label.trim() || "(untitled)",
		status: "running",
		startedAt: Date.now(),
	};
	tasks.set(id, task);
	notify(task);

	promise.then(
		(reply) => {
			const preview = (reply ?? "").trim().slice(0, 120);
			const updated: BgTask = {
				...task,
				status: "done",
				finishedAt: Date.now(),
				resultPreview: preview || "(no output)",
			};
			tasks.set(id, updated);
			notify(updated);
		},
		(err) => {
			const updated: BgTask = {
				...task,
				status: "error",
				finishedAt: Date.now(),
				error: err instanceof Error ? err.message : String(err),
			};
			tasks.set(id, updated);
			notify(updated);
		},
	);

	return id;
}

export function list(): BgTask[] {
	// Most recent first so the panel reads top-down like a changelog.
	return Array.from(tasks.values()).sort((a, b) => b.startedAt - a.startedAt);
}

export function get(id: string): BgTask | undefined {
	return tasks.get(id);
}

export function runningCount(): number {
	let n = 0;
	for (const t of tasks.values()) if (t.status === "running") n++;
	return n;
}

export function clear(id: string): void {
	tasks.delete(id);
}

/** Subscribe to state changes. Returns an unsubscribe fn. */
export function onChange(fn: Listener): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}
