/**
 * @8gent/telegram-bot - Bridge Adapter
 *
 * Glue between the daemon WebSocket gateway and the multi-step Telegram
 * surface. Reuses TaskRunner / SessionStore / FileSender so the same logic
 * powers both stand-alone bots and the production telegram-bridge.
 *
 * Wiring:
 *   user message      -> session.getOrCreate -> TaskRunner.start + sendPrompt
 *   tool:start        -> TaskRunner.addStep + markStepActive
 *   tool:result       -> TaskRunner.markStepDone (with summary)
 *   agent:stream      -> if final, TaskRunner.complete; else live activity
 *   agent:error       -> TaskRunner.fail (with retry keyboard)
 *   approval:required -> TaskRunner.awaitingUser (with approval keyboard)
 *
 * The adapter is transport-pluggable: a real DaemonClient drives it in
 * production; a fake event source drives it in tests.
 */

import type { DaemonClient, EventPayloads } from "./daemon-client";
import { FileSender } from "./file-sender";
import { taskCompleteKeyboard, taskFailedKeyboard, taskRunningKeyboard } from "./keyboards";
import {
	detectFilePaths,
	splitIntoChunks,
	summarizeToolCall,
	summarizeToolResult,
	truncateForMobile,
} from "./mobile-formatter";
import { SessionStore } from "./session-store";
import { type TaskAttachment, TaskRunner, type TaskRunnerEvents } from "./task-runner";
import type { InlineKeyboardMarkup } from "./types";

const TELEGRAM_API = "https://api.telegram.org/bot";

export interface BridgeAdapterConfig {
	telegramToken: string;
	chatId: string;
	daemon: DaemonClient;
	sessionStore?: SessionStore;
	fileSender?: FileSender;
	/** Auto-attach files referenced in agent output (default true). */
	autoAttachFiles?: boolean;
	/** Override the editor throttle for tests. */
	editThrottleMs?: number;
}

interface RunningTask {
	runner: TaskRunner;
	originalText: string;
	/** Stack of step ids per tool name - tool:result pops the most recent. */
	stepStackByTool: Map<string, string[]>;
}

export class TelegramBridgeAdapter {
	private telegramToken: string;
	private chatId: string;
	private daemon: DaemonClient;
	private sessions: SessionStore;
	private files: FileSender;
	private autoAttachFiles: boolean;
	private editThrottleMs: number;
	private current: RunningTask | null = null;
	private offHandlers: Array<() => void> = [];

	constructor(config: BridgeAdapterConfig) {
		this.telegramToken = config.telegramToken;
		this.chatId = config.chatId;
		this.daemon = config.daemon;
		this.sessions = config.sessionStore ?? new SessionStore();
		this.files =
			config.fileSender ?? new FileSender({ token: config.telegramToken, chatId: config.chatId });
		this.autoAttachFiles = config.autoAttachFiles ?? true;
		this.editThrottleMs = config.editThrottleMs ?? 1100;
		this.subscribe();
	}

	/** Begin a new multi-step task for an incoming user message. */
	async handleUserMessage(text: string): Promise<void> {
		const session = this.sessions.getOrCreate(this.chatId);
		session.sessionId = this.daemon.getSessionId();
		this.sessions.recordMessage(this.chatId, "user", text);

		// If a task is already in flight, queue rejection - the surface is
		// expected to gate this. We still handle it gracefully.
		if (this.current) {
			await this.sendPlain("Still working on the previous task. Cancel it first or wait.");
			return;
		}

		const runner = new TaskRunner(
			{ chatId: this.chatId, sessionId: this.daemon.getSessionId(), description: text },
			this.runnerEvents(),
			{ editThrottleMs: this.editThrottleMs },
		);
		this.current = { runner, originalText: text, stepStackByTool: new Map() };
		this.sessions.linkTask(this.chatId, runner.task.id);

		await runner.start(taskRunningKeyboard(runner.task.id));
		this.daemon.sendPrompt(text);
	}

	/** Cancel the in-flight task (callback handler). */
	async cancelCurrent(reason = "Cancelled by user"): Promise<boolean> {
		if (!this.current) return false;
		const { runner } = this.current;
		await runner.cancel(reason);
		runner.destroy();
		this.current = null;
		this.sessions.linkTask(this.chatId, null);
		this.daemon.resetSession();
		return true;
	}

	/** Retry the most-recent task (callback handler). */
	async retryCurrent(): Promise<boolean> {
		if (!this.current) return false;
		const text = this.current.originalText;
		await this.cancelCurrent("Retrying");
		await this.handleUserMessage(text);
		return true;
	}

	/** Tear down event subscriptions. */
	close(): void {
		for (const off of this.offHandlers) off();
		this.offHandlers = [];
		if (this.current) {
			this.current.runner.destroy();
			this.current = null;
		}
		this.sessions.flush();
	}

	// ── Event wiring ────────────────────────────────────────

	private subscribe(): void {
		this.offHandlers.push(this.daemon.on("tool:start", (p) => this.onToolStart(p)));
		this.offHandlers.push(this.daemon.on("tool:result", (p) => this.onToolResult(p)));
		this.offHandlers.push(this.daemon.on("agent:stream", (p) => this.onAgentStream(p)));
		this.offHandlers.push(this.daemon.on("agent:error", (p) => this.onAgentError(p)));
		this.offHandlers.push(this.daemon.on("session:end", () => this.onSessionEnd()));
	}

	private onToolStart(payload: EventPayloads["tool:start"]): void {
		if (!this.current) return;
		const summary = summarizeToolCall(payload.tool, payload.input);
		const label = `${summary.icon} ${summary.label}`;
		const step = this.current.runner.addStep(label, payload.tool);
		const stack = this.current.stepStackByTool.get(payload.tool) ?? [];
		stack.push(step.id);
		this.current.stepStackByTool.set(payload.tool, stack);
		this.current.runner.markStepActive(step.id);
	}

	private onToolResult(payload: EventPayloads["tool:result"]): void {
		if (!this.current) return;
		const summary = summarizeToolResult(payload.output, payload.durationMs);
		const stack = this.current.stepStackByTool.get(payload.tool);
		const stepId = stack?.shift();
		if (stepId) {
			this.current.runner.markStepDone(stepId, summary);
		} else {
			const active = this.current.runner.task.steps.find((s) => s.status === "active");
			if (active) this.current.runner.markStepDone(active.id, summary);
		}
	}

	private async onAgentStream(payload: EventPayloads["agent:stream"]): Promise<void> {
		if (!this.current) return;
		if (!payload.final) return;
		const text = payload.chunk ?? "";
		const trimmed = truncateForMobile(text);
		const taskId = this.current.runner.task.id;

		if (this.autoAttachFiles) {
			for (const path of detectFilePaths(text)) {
				this.current.runner.attachFile({
					kind: guessKind(path),
					path,
					filename: path.split("/").pop() || "file",
				});
			}
		}

		await this.current.runner.complete(
			trimmed,
			taskCompleteKeyboard(taskId, this.current.runner.task.attachments.length > 0),
		);
		this.sessions.recordMessage(this.chatId, "bot", trimmed);

		// If the response exceeds a single chunk, flush extras as plain messages.
		const chunks = splitIntoChunks(text);
		if (chunks.length > 1) {
			for (const extra of chunks.slice(1)) {
				await this.sendPlain(extra);
			}
		}

		this.current.runner.destroy();
		this.current = null;
		this.sessions.linkTask(this.chatId, null);
	}

	private async onAgentError(payload: EventPayloads["agent:error"]): Promise<void> {
		if (!this.current) return;
		const taskId = this.current.runner.task.id;
		await this.current.runner.fail(payload.error || "Unknown error", taskFailedKeyboard(taskId));
		this.current.runner.destroy();
		this.current = null;
		this.sessions.linkTask(this.chatId, null);
	}

	private onSessionEnd(): void {
		// Daemon side may evict; we'll lazily recreate on the next prompt.
	}

	// ── Telegram I/O ────────────────────────────────────────

	private runnerEvents(): TaskRunnerEvents {
		return {
			send: (text, replyMarkup) => this.tgSend(text, replyMarkup),
			edit: (id, text, replyMarkup) => this.tgEdit(id, text, replyMarkup),
			sendFile: (att) => this.files.send(att),
		};
	}

	private async sendPlain(text: string): Promise<void> {
		await this.tgSend(text);
	}

	private async tgSend(text: string, replyMarkup?: InlineKeyboardMarkup): Promise<number> {
		const chunks = splitIntoChunks(text);
		let lastId = 0;
		for (let i = 0; i < chunks.length; i++) {
			const isLast = i === chunks.length - 1;
			lastId = await this.callTelegram("sendMessage", {
				chat_id: this.chatId,
				text: chunks[i],
				parse_mode: "Markdown",
				reply_markup: isLast ? replyMarkup : undefined,
				disable_web_page_preview: true,
			});
		}
		return lastId;
	}

	private async tgEdit(
		messageId: number,
		text: string,
		replyMarkup?: InlineKeyboardMarkup,
	): Promise<void> {
		try {
			await this.callTelegram("editMessageText", {
				chat_id: this.chatId,
				message_id: messageId,
				text: truncateForMobile(text, 3500),
				parse_mode: "Markdown",
				reply_markup: replyMarkup,
				disable_web_page_preview: true,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes("message is not modified")) return;
			// Drop everything else - edits are non-critical.
		}
	}

	private async callTelegram(method: string, body: Record<string, unknown>): Promise<number> {
		const url = `${TELEGRAM_API}${this.telegramToken}/${method}`;
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		const json = (await res.json()) as {
			ok: boolean;
			description?: string;
			result?: { message_id?: number };
		};
		if (!json.ok) {
			throw new Error(`telegram ${method}: ${json.description ?? "unknown"}`);
		}
		return json.result?.message_id ?? 0;
	}
}

function guessKind(path: string): TaskAttachment["kind"] {
	const ext = (path.split(".").pop() ?? "").toLowerCase();
	if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return "photo";
	return "document";
}
