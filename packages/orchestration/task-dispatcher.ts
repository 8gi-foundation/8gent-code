/**
 * TaskDispatcher — atomic task dispatch with claimed map + state machine.
 *
 * Prevents two concurrent roles (Engineer, QA) from picking up the same task.
 * State transitions: pending → claimed → running → completed | failed → retrying → pending
 */

export type TaskState =
	| "pending"
	| "claimed"
	| "running"
	| "completed"
	| "failed"
	| "retrying";

export interface DispatchedTask {
	id: string;
	title: string;
	state: TaskState;
	claimedBy?: string;
	claimedAt?: number;
	startedAt?: number;
	completedAt?: number;
	attempts: number;
	result?: string;
	error?: string;
}

const BASE_DELAY_MS = 1000;
const JITTER_MS = 500;
const STALL_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes

/** Deterministic jitter from task ID — same task always gets same jitter offset */
function idHash(id: string): number {
	let h = 0;
	for (let i = 0; i < id.length; i++)
		h = (Math.imul(31, h) + id.charCodeAt(i)) | 0;
	return Math.abs(h);
}

export class TaskDispatcher {
	private tasks = new Map<string, DispatchedTask>();

	/** Add a new task in pending state */
	enqueue(id: string, title: string): DispatchedTask {
		const task: DispatchedTask = { id, title, state: "pending", attempts: 0 };
		this.tasks.set(id, task);
		return task;
	}

	/**
	 * Atomically claim a task for a role.
	 * Returns the task if claim succeeded, null if already claimed or not pending.
	 */
	claim(taskId: string, roleId: string): DispatchedTask | null {
		const task = this.tasks.get(taskId);
		if (!task || task.state !== "pending") return null;
		task.state = "claimed";
		task.claimedBy = roleId;
		task.claimedAt = Date.now();
		return task;
	}

	/** Mark task as running (call after claim succeeds) */
	start(taskId: string): void {
		const task = this.tasks.get(taskId);
		if (!task || task.state !== "claimed") return;
		task.state = "running";
		task.startedAt = Date.now();
		task.attempts++;
	}

	/** Mark task complete */
	complete(taskId: string, result: string): void {
		const task = this.tasks.get(taskId);
		if (!task) return;
		task.state = "completed";
		task.result = result;
		task.completedAt = Date.now();
	}

	/** Mark task failed — schedules retry with quadratic backoff + jitter */
	fail(taskId: string, error: string): void {
		const task = this.tasks.get(taskId);
		if (!task) return;
		task.state = "failed";
		task.error = error;
		const delay =
			Math.pow(task.attempts, 2) * BASE_DELAY_MS + (idHash(taskId) % JITTER_MS);
		setTimeout(() => {
			if (task.state === "failed") {
				task.state = "pending";
				task.claimedBy = undefined;
				task.claimedAt = undefined;
			}
		}, delay);
	}

	/** Get next unclaimed pending task */
	nextPending(): DispatchedTask | null {
		for (const task of this.tasks.values()) {
			if (task.state === "pending") return task;
		}
		return null;
	}

	/** Release tasks that were claimed but never started (stalled) */
	releaseStalled(): string[] {
		const now = Date.now();
		const released: string[] = [];
		for (const task of this.tasks.values()) {
			if (
				task.state === "claimed" &&
				task.claimedAt &&
				now - task.claimedAt > STALL_TIMEOUT_MS
			) {
				task.state = "pending";
				task.claimedBy = undefined;
				task.claimedAt = undefined;
				released.push(task.id);
			}
		}
		return released;
	}

	/** Get all tasks (for UI display) */
	getAll(): DispatchedTask[] {
		return [...this.tasks.values()];
	}

	/** Get tasks by state */
	getByState(state: TaskState): DispatchedTask[] {
		return [...this.tasks.values()].filter((t) => t.state === state);
	}
}

/** Global singleton dispatcher for the TUI session */
export const globalDispatcher = new TaskDispatcher();
