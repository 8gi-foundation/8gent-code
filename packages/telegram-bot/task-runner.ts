/**
 * @8gent/telegram-bot - TaskRunner
 *
 * Multi-step task orchestration with a single live-edited progress message.
 * Mirrors the Claude Dispatch mobile pattern: one anchor message per task,
 * edited as steps complete. Final summary replaces in-place. Files are
 * delivered as separate Telegram documents/photos after the summary.
 *
 * The runner is transport-agnostic: it owns the data model and emits intents
 * (send/edit/sendFile). A surface adapter (telegram-bridge or stand-alone bot)
 * wires those to actual Telegram API calls.
 */

import type { InlineKeyboardMarkup } from "./types";

export type TaskStatus =
	| "queued"
	| "planning"
	| "running"
	| "awaiting_user"
	| "succeeded"
	| "failed"
	| "cancelled";

export type StepStatus = "pending" | "active" | "done" | "failed" | "skipped";

export interface TaskStep {
	id: string;
	label: string;
	status: StepStatus;
	summary?: string;
	startedAt?: number;
	completedAt?: number;
	tool?: string;
}

export interface TaskAttachment {
	kind: "document" | "photo";
	path?: string;
	buffer?: Buffer;
	filename: string;
	caption?: string;
}

export interface Task {
	id: string;
	chatId: string;
	sessionId: string | null;
	description: string;
	status: TaskStatus;
	steps: TaskStep[];
	progressMessageId?: number;
	attachments: TaskAttachment[];
	startedAt: number;
	completedAt?: number;
	finalText?: string;
	error?: string;
}

export interface TaskRunnerEvents {
	send: (text: string, replyMarkup?: InlineKeyboardMarkup) => Promise<number>;
	edit: (messageId: number, text: string, replyMarkup?: InlineKeyboardMarkup) => Promise<void>;
	sendFile: (attachment: TaskAttachment) => Promise<void>;
}

export interface RenderOptions {
	includeSpinner?: boolean;
	includeTiming?: boolean;
}

let counter = 0;
function newId(prefix: string): string {
	counter = (counter + 1) % 1_000_000;
	return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}`;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function spinnerFrame(seed = Date.now()): string {
	return SPINNER_FRAMES[Math.floor(seed / 100) % SPINNER_FRAMES.length];
}

/**
 * Render the progress block for a task. Pure function so tests can pin output.
 */
export function renderTaskProgress(task: Task, opts: RenderOptions = {}): string {
	const lines: string[] = [];
	const head = headlineFor(task);
	lines.push(`*${head}*`);
	lines.push(escapeMd(truncate(task.description, 240)));
	lines.push("");

	if (task.steps.length === 0 && task.status === "planning") {
		lines.push("_planning..._");
	}

	for (const step of task.steps) {
		lines.push(renderStep(step, opts.includeSpinner ?? true));
	}

	if (opts.includeTiming && task.completedAt) {
		const sec = ((task.completedAt - task.startedAt) / 1000).toFixed(1);
		lines.push("");
		lines.push(`_done in ${sec}s_`);
	} else if (task.status === "running" || task.status === "planning") {
		const sec = ((Date.now() - task.startedAt) / 1000).toFixed(0);
		lines.push("");
		lines.push(`_${sec}s elapsed_`);
	}

	if (task.status === "failed" && task.error) {
		lines.push("");
		lines.push(`*Error:* ${escapeMd(truncate(task.error, 400))}`);
	}

	if (task.finalText && (task.status === "succeeded" || task.status === "failed")) {
		lines.push("");
		lines.push(truncate(task.finalText, 1500));
	}

	return lines.join("\n");
}

function headlineFor(task: Task): string {
	switch (task.status) {
		case "queued":
			return "Queued";
		case "planning":
			return "Planning";
		case "running":
			return "Working...";
		case "awaiting_user":
			return "Waiting on you";
		case "succeeded":
			return "Done";
		case "failed":
			return "Failed";
		case "cancelled":
			return "Cancelled";
	}
}

function renderStep(step: TaskStep, withSpinner: boolean): string {
	const icon = stepIcon(step, withSpinner);
	const summary = step.summary ? ` - ${escapeMd(truncate(step.summary, 100))}` : "";
	return `${icon} ${escapeMd(truncate(step.label, 100))}${summary}`;
}

function stepIcon(step: TaskStep, withSpinner: boolean): string {
	switch (step.status) {
		case "pending":
			return "○";
		case "active":
			return withSpinner ? spinnerFrame() : "◐";
		case "done":
			return "✓";
		case "failed":
			return "✗";
		case "skipped":
			return "—";
	}
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max - 3)}...`;
}

/**
 * Escape characters that break Telegram Markdown (legacy mode).
 * We intentionally keep `*`, `_`, `` ` `` working - the renderer uses them.
 * Only escape characters that have no formatting meaning inside our renders.
 */
function escapeMd(text: string): string {
	return text.replace(/([\[\]()])/g, "\\$1");
}

/**
 * TaskRunner manages a single task's lifecycle. Stateful but isolated.
 *
 * Adapters wire `events.send/edit/sendFile` to a Telegram surface. The runner
 * coalesces edits with `editThrottleMs` to stay under Telegram's rate limits
 * (~1 edit/sec per chat).
 */
export class TaskRunner {
	readonly task: Task;
	private events: TaskRunnerEvents;
	private editThrottleMs: number;
	private lastEditAt = 0;
	private pendingEditTimer: ReturnType<typeof setTimeout> | null = null;
	private destroyed = false;

	constructor(
		init: { chatId: string; sessionId: string | null; description: string },
		events: TaskRunnerEvents,
		options: { editThrottleMs?: number } = {},
	) {
		this.task = {
			id: newId("task"),
			chatId: init.chatId,
			sessionId: init.sessionId,
			description: init.description,
			status: "queued",
			steps: [],
			attachments: [],
			startedAt: Date.now(),
		};
		this.events = events;
		this.editThrottleMs = options.editThrottleMs ?? 1100;
	}

	/** Send the initial progress message. Must be called before steps. */
	async start(replyMarkup?: InlineKeyboardMarkup): Promise<void> {
		this.task.status = "planning";
		const text = renderTaskProgress(this.task);
		const messageId = await this.events.send(text, replyMarkup);
		this.task.progressMessageId = messageId;
		this.lastEditAt = Date.now();
	}

	/** Add a planned step (no status change). */
	addStep(label: string, tool?: string): TaskStep {
		const step: TaskStep = {
			id: newId("step"),
			label,
			status: "pending",
			tool,
		};
		this.task.steps.push(step);
		this.scheduleEdit();
		return step;
	}

	/** Mark a step active by id or label. Promotes the task to running. */
	markStepActive(idOrLabel: string): void {
		const step = this.findStep(idOrLabel);
		if (!step) return;
		// Demote previous active steps to done if they weren't terminal yet.
		for (const s of this.task.steps) {
			if (s.id === step.id) continue;
			if (s.status === "active") s.status = "done";
		}
		step.status = "active";
		step.startedAt = Date.now();
		this.task.status = "running";
		this.scheduleEdit();
	}

	/** Mark a step done with optional summary text. */
	markStepDone(idOrLabel: string, summary?: string): void {
		const step = this.findStep(idOrLabel);
		if (!step) return;
		step.status = "done";
		if (summary) step.summary = summary;
		step.completedAt = Date.now();
		this.scheduleEdit();
	}

	/** Mark a step failed with error message. */
	markStepFailed(idOrLabel: string, summary?: string): void {
		const step = this.findStep(idOrLabel);
		if (!step) return;
		step.status = "failed";
		if (summary) step.summary = summary;
		step.completedAt = Date.now();
		this.scheduleEdit();
	}

	/** Queue a file attachment to be delivered after the final summary. */
	attachFile(attachment: TaskAttachment): void {
		this.task.attachments.push(attachment);
	}

	/** Mark task awaiting user input (e.g. approval, clarification). */
	awaitingUser(prompt: string, replyMarkup?: InlineKeyboardMarkup): Promise<void> {
		this.task.status = "awaiting_user";
		this.task.finalText = prompt;
		return this.flushEdit(replyMarkup);
	}

	/** Complete the task with a final result. Sends queued attachments. */
	async complete(finalText: string, replyMarkup?: InlineKeyboardMarkup): Promise<void> {
		// Auto-finish any still-active step.
		for (const s of this.task.steps) {
			if (s.status === "active") s.status = "done";
		}
		this.task.status = "succeeded";
		this.task.finalText = finalText;
		this.task.completedAt = Date.now();
		await this.flushEdit(replyMarkup);
		await this.deliverAttachments();
	}

	/** Mark task failed with error. */
	async fail(error: string, replyMarkup?: InlineKeyboardMarkup): Promise<void> {
		for (const s of this.task.steps) {
			if (s.status === "active") s.status = "failed";
		}
		this.task.status = "failed";
		this.task.error = error;
		this.task.completedAt = Date.now();
		await this.flushEdit(replyMarkup);
	}

	/** Mark task cancelled (user-initiated). */
	async cancel(reason = "Cancelled by user"): Promise<void> {
		for (const s of this.task.steps) {
			if (s.status === "active" || s.status === "pending") s.status = "skipped";
		}
		this.task.status = "cancelled";
		this.task.error = reason;
		this.task.completedAt = Date.now();
		await this.flushEdit();
	}

	private findStep(idOrLabel: string): TaskStep | undefined {
		return this.task.steps.find((s) => s.id === idOrLabel || s.label === idOrLabel);
	}

	private scheduleEdit(): void {
		if (this.destroyed) return;
		if (this.pendingEditTimer) return;
		const elapsed = Date.now() - this.lastEditAt;
		const wait = Math.max(0, this.editThrottleMs - elapsed);
		this.pendingEditTimer = setTimeout(() => {
			this.pendingEditTimer = null;
			this.flushEdit().catch(() => {
				// Swallow - edit failures are non-fatal (rate limit, etc).
			});
		}, wait);
	}

	private async flushEdit(replyMarkup?: InlineKeyboardMarkup): Promise<void> {
		if (this.destroyed) return;
		if (this.pendingEditTimer) {
			clearTimeout(this.pendingEditTimer);
			this.pendingEditTimer = null;
		}
		if (this.task.progressMessageId === undefined) return;
		const text = renderTaskProgress(this.task);
		await this.events.edit(this.task.progressMessageId, text, replyMarkup);
		this.lastEditAt = Date.now();
	}

	private async deliverAttachments(): Promise<void> {
		for (const att of this.task.attachments) {
			try {
				await this.events.sendFile(att);
			} catch {
				// Continue delivering remaining files on individual failure.
			}
		}
		this.task.attachments = [];
	}

	/** Clean up timers. Safe to call multiple times. */
	destroy(): void {
		this.destroyed = true;
		if (this.pendingEditTimer) {
			clearTimeout(this.pendingEditTimer);
			this.pendingEditTimer = null;
		}
	}
}
