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
import {
	CB_PREFIX,
	runStatusKeyboard,
	taskCompleteKeyboard,
	taskFailedKeyboard,
	taskRunningKeyboard,
} from "./keyboards";
import {
	detectFilePaths,
	splitIntoChunks,
	summarizeToolCall,
	summarizeToolResult,
	truncateForMobile,
} from "./mobile-formatter";
import {
	ONLY_STARTER_CANCEL,
	ONLY_STARTER_STEPS,
	RUN_FINISHED,
	RUN_GONE,
	type RunStep,
	STATUS_EDIT_INTERVAL_MS,
	STEPS_RETENTION_MS,
	StatusLine,
	buildStepsLog,
	doneOutcome,
	failureSentence,
	statusText,
	stepChanges,
	stepLabel,
	stepResult,
	summariseStep,
} from "./run-display";
import { SessionStore } from "./session-store";
import { type TaskAttachment, TaskRunner, type TaskRunnerEvents } from "./task-runner";
import type { InlineKeyboardMarkup } from "./types";

const TELEGRAM_API = "https://api.telegram.org/bot";

/**
 * Whether a turn shows the old full tool-trace card ("Working...", one line
 * per tool call). Off by default in DMs and groups alike: the default surface
 * is one status line with Cancel and Show steps. EIGHT_TG_TRACE=on|1|true
 * brings the old trace back, for debugging. `chatId` is kept for callers that
 * pass it; it no longer changes the answer.
 */
export function traceVisibleFor(
	_chatId: string,
	env: Record<string, string | undefined> = process.env,
): boolean {
	const v = (env.EIGHT_TG_TRACE ?? "").trim().toLowerCase();
	return v === "on" || v === "1" || v === "true";
}

/** Telegram drops the typing indicator after about 5 s, so a turn refreshes it. */
const TYPING_REFRESH_MS = 4000;

export interface BridgeAdapterConfig {
	telegramToken: string;
	/** Fixed destination. Omit when the destination varies per turn. */
	chatId?: string;
	/**
	 * Destination resolver, evaluated at send time. A bridge serving more
	 * than one allowlisted chat passes this so a reply lands in the chat the
	 * message came from; a fixed `chatId` cannot express that, because the
	 * adapter is constructed once at boot and the daemon's reply carries no
	 * chat of its own.
	 */
	resolveChatId?: () => string;
	/** Forum topic of the turn in flight, evaluated at send time (C-G6). Undefined = no topic. */
	resolveThreadId?: () => number | undefined;
	/** Called when a turn ends, by final reply or by error, after its last send. */
	onTurnEnd?: () => void;
	/**
	 * Evaluated once per turn. true: the old live task card with a line per tool
	 * call (debugging). false or omitted (default): one status message edited in
	 * place with Cancel and Show steps, then the final text as a plain reply.
	 */
	showTrace?: () => boolean;
	/** Minimum gap between live status edits. Default 5 s. */
	statusIntervalMs?: number;
	/** How long Show steps stays on a finished run. Default 24 h. Held in memory only. */
	stepsRetentionMs?: number;
	daemon: DaemonClient;
	sessionStore?: SessionStore;
	fileSender?: FileSender;
	/** Auto-attach files referenced in agent output (default true). */
	autoAttachFiles?: boolean;
	/** Override the editor throttle for tests. */
	editThrottleMs?: number;
	/**
	 * Called once with the agent's final reply text after it has been posted.
	 * The bridge uses this for voice mode: the text has already landed, so a
	 * failure here must never affect the reply. Errors are swallowed.
	 */
	onFinalReply?: (text: string) => void | Promise<void>;
}

/** Who pressed start: only they may press the run's buttons. */
export interface RunStarter {
	fromId?: number;
	chatType?: string;
}

export interface RunCallbackResult {
	/** Private answer shown to the presser (answerCallbackQuery text). */
	text?: string;
	alert?: boolean;
}

interface StatusRun {
	id: string;
	chatId: string;
	threadId?: number;
	starter: RunStarter;
	messageId: number;
	request: string;
	startedAt: number;
	endedAt?: number;
	state: "running" | "done" | "stopped" | "failed";
	steps: RunStep[];
	line: StatusLine;
	error?: string;
	/** Task buttons kept on the finished message (Continue, New task, Resend files / Retry, Drop). */
	finishRows?: InlineKeyboardMarkup["inline_keyboard"];
	expiry?: ReturnType<typeof setTimeout>;
}

let runCounter = 0;
function newRunId(): string {
	runCounter = (runCounter + 1) % 1_000_000;
	return `r${Date.now().toString(36)}${runCounter.toString(36)}`;
}

interface RunningTask {
	/** Old trace card (EIGHT_TG_TRACE=on). Absent in the default status mode. */
	runner?: TaskRunner;
	/** Default status message. */
	status?: StatusRun;
	originalText: string;
	typingTimer?: ReturnType<typeof setInterval>;
	/** Stack of step ids per tool name - tool:result pops the most recent. */
	stepStackByTool: Map<string, string[]>;
}

export class TelegramBridgeAdapter {
	private telegramToken: string;
	private resolveChat: () => string;
	private resolveThread?: () => number | undefined;
	private onTurnEnd?: () => void;
	private showTrace?: () => boolean;
	/** Read-through, so every existing `this.chatId` use resolves per send. */
	private get chatId(): string {
		return this.resolveChat();
	}
	private daemon: DaemonClient;
	private sessions: SessionStore;
	private files: FileSender;
	private autoAttachFiles: boolean;
	private editThrottleMs: number;
	private statusIntervalMs: number;
	private stepsRetentionMs: number;
	/** Finished runs whose Show steps button is still live. In memory: lost on restart by design. */
	private finishedRuns = new Map<string, StatusRun>();
	private onFinalReply?: (text: string) => void | Promise<void>;
	private current: RunningTask | null = null;
	private offHandlers: Array<() => void> = [];

	constructor(config: BridgeAdapterConfig) {
		this.telegramToken = config.telegramToken;
		if (!config.resolveChatId && config.chatId === undefined) {
			throw new Error("BridgeAdapterConfig needs chatId or resolveChatId");
		}
		const fixed = config.chatId;
		this.resolveChat = config.resolveChatId ?? (() => fixed as string);
		this.resolveThread = config.resolveThreadId;
		this.onTurnEnd = config.onTurnEnd;
		this.showTrace = config.showTrace;
		this.daemon = config.daemon;
		this.sessions = config.sessionStore ?? new SessionStore();
		this.files =
			config.fileSender ??
			new FileSender({
				token: config.telegramToken,
				chatId: config.chatId,
				resolveChatId: config.resolveChatId,
				resolveThreadId: config.resolveThreadId,
			});
		this.autoAttachFiles = config.autoAttachFiles ?? true;
		this.editThrottleMs = config.editThrottleMs ?? 1100;
		this.statusIntervalMs = config.statusIntervalMs ?? STATUS_EDIT_INTERVAL_MS;
		this.stepsRetentionMs = config.stepsRetentionMs ?? STEPS_RETENTION_MS;
		this.onFinalReply = config.onFinalReply;
		this.subscribe();
	}

	/**
	 * Begin a new multi-step task for an incoming user message.
	 * `promptPrefix` is extra context for the model only (recalled memory). It is not recorded in
	 * session history and not shown in the task card, which both carry `text` alone.
	 */
	async handleUserMessage(
		text: string,
		promptPrefix = "",
		starter: RunStarter = {},
	): Promise<void> {
		const session = this.sessions.getOrCreate(this.chatId);
		session.sessionId = this.daemon.getSessionId();
		this.sessions.recordMessage(this.chatId, "user", text);

		// If a task is already in flight, queue rejection - the surface is
		// expected to gate this. We still handle it gracefully.
		if (this.current) {
			await this.sendPlain("Still working on the previous task. Cancel it first or wait.");
			return;
		}

		let trace = false;
		try {
			trace = this.showTrace ? this.showTrace() : false;
		} catch {
			trace = false;
		}

		if (trace) {
			const runner = new TaskRunner(
				{ chatId: this.chatId, sessionId: this.daemon.getSessionId(), description: text },
				this.runnerEvents(),
				{ editThrottleMs: this.editThrottleMs },
			);
			this.current = { runner, originalText: text, stepStackByTool: new Map() };
			this.sessions.linkTask(this.chatId, runner.task.id);
			await runner.start(taskRunningKeyboard(runner.task.id));
		} else {
			const status = await this.startStatus(text, starter);
			this.current = { status, originalText: text, stepStackByTool: new Map() };
			this.sessions.linkTask(this.chatId, status.id);
		}
		this.daemon.sendPrompt(promptPrefix ? `${promptPrefix}\n\n${text}` : text);
	}

	/** Cancel the in-flight task (callback handler). */
	async cancelCurrent(reason = "Cancelled by user"): Promise<boolean> {
		if (!this.current) return false;
		const cur = this.current;
		this.stopTyping(cur);
		if (cur.status) {
			const run = cur.status;
			const halfDone = run.steps.some((s) => !s.done && s.changes);
			await this.finishStatus(run, "stopped", statusText.cancelled(halfDone));
		} else if (cur.runner) {
			await cur.runner.cancel(reason);
			cur.runner.destroy();
		}
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
			this.stopTyping(this.current);
			this.current.runner?.destroy();
			this.current.status?.line.close();
			this.current = null;
		}
		for (const run of this.finishedRuns.values()) {
			if (run.expiry) clearTimeout(run.expiry);
		}
		this.finishedRuns.clear();
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
		if (this.current.status) {
			const run = this.current.status;
			const step: RunStep = {
				at: Date.now(),
				tool: payload.tool,
				label: stepLabel(payload.tool, payload.input),
				changes: stepChanges(payload.tool, payload.input),
				done: false,
			};
			run.steps.push(step);
			const stack = this.stepStack.get(run.id) ?? new Map<string, RunStep[]>();
			const list = stack.get(payload.tool) ?? [];
			list.push(step);
			stack.set(payload.tool, list);
			this.stepStack.set(run.id, stack);
			run.line.set(summariseStep(payload.tool, payload.input));
			return;
		}
		const runner = this.current.runner;
		if (!runner) return;
		const summary = summarizeToolCall(payload.tool, payload.input);
		const label = `${summary.icon} ${summary.label}`;
		const step = runner.addStep(label, payload.tool);
		const stack = this.current.stepStackByTool.get(payload.tool) ?? [];
		stack.push(step.id);
		this.current.stepStackByTool.set(payload.tool, stack);
		runner.markStepActive(step.id);
	}

	private onToolResult(payload: EventPayloads["tool:result"]): void {
		if (!this.current) return;
		if (this.current.status) {
			const run = this.current.status;
			const step = this.stepStack.get(run.id)?.get(payload.tool)?.shift();
			if (step) {
				step.done = true;
				step.result = stepResult(payload.output, payload.durationMs);
			}
			return;
		}
		const runner = this.current.runner;
		if (!runner) return;
		const summary = summarizeToolResult(payload.output, payload.durationMs);
		const stack = this.current.stepStackByTool.get(payload.tool);
		const stepId = stack?.shift();
		if (stepId) {
			runner.markStepDone(stepId, summary);
		} else {
			const active = runner.task.steps.find((s) => s.status === "active");
			if (active) runner.markStepDone(active.id, summary);
		}
	}

	private async onAgentStream(payload: EventPayloads["agent:stream"]): Promise<void> {
		if (!this.current) return;
		if (!payload.final) return;
		const text = payload.chunk ?? "";
		const trimmed = truncateForMobile(text);
		const cur = this.current;
		this.stopTyping(cur);

		if (cur.status) {
			const run = cur.status;
			const outcome = doneOutcome(text);
			const paths = this.autoAttachFiles ? detectFilePaths(text) : [];
			await this.finishStatus(
				run,
				"done",
				statusText.done(outcome),
				taskCompleteKeyboard(run.id, paths.length > 0).inline_keyboard,
			);
			if (!outcome || text.trim() !== outcome) await this.sendReply(text);
			if (this.autoAttachFiles) {
				for (const path of paths) {
					await this.files
						.send({ kind: guessKind(path), path, filename: path.split("/").pop() || "file" })
						.catch(() => {});
				}
			}
			this.sessions.recordMessage(this.chatId, "bot", trimmed);
			await this.runFinalReply(text);
			this.current = null;
			this.sessions.linkTask(this.chatId, null);
			this.endTurn();
			return;
		}

		const runner = cur.runner;
		if (!runner) return;
		const taskId = runner.task.id;

		if (this.autoAttachFiles) {
			for (const path of detectFilePaths(text)) {
				runner.attachFile({
					kind: guessKind(path),
					path,
					filename: path.split("/").pop() || "file",
				});
			}
		}

		await runner.complete(
			trimmed,
			taskCompleteKeyboard(taskId, runner.task.attachments.length > 0),
		);
		this.sessions.recordMessage(this.chatId, "bot", trimmed);
		await this.runFinalReply(text);

		// If the response exceeds a single chunk, flush extras as plain messages.
		const chunks = splitIntoChunks(text);
		if (chunks.length > 1) {
			for (const extra of chunks.slice(1)) {
				await this.sendPlain(extra);
			}
		}

		runner.destroy();
		this.current = null;
		this.sessions.linkTask(this.chatId, null);
		this.endTurn();
	}

	private async runFinalReply(text: string): Promise<void> {
		if (!this.onFinalReply) return;
		try {
			await this.onFinalReply(text);
		} catch (err) {
			console.error("[bridge-adapter] onFinalReply failed:", err);
		}
	}

	private endTurn(): void {
		try {
			this.onTurnEnd?.();
		} catch {}
	}

	private async onAgentError(payload: EventPayloads["agent:error"]): Promise<void> {
		if (!this.current) return;
		const cur = this.current;
		this.stopTyping(cur);
		if (cur.status) {
			cur.status.error = payload.error || "Unknown error";
			await this.finishStatus(
				cur.status,
				"failed",
				statusText.failed(failureSentence(payload.error || "")),
				taskFailedKeyboard(cur.status.id).inline_keyboard,
			);
		} else if (cur.runner) {
			await cur.runner.fail(
				payload.error || "Unknown error",
				taskFailedKeyboard(cur.runner.task.id),
			);
			cur.runner.destroy();
		}
		this.current = null;
		this.sessions.linkTask(this.chatId, null);
		this.endTurn();
	}

	private onSessionEnd(): void {
		// Daemon side may evict; we'll lazily recreate on the next prompt.
	}

	// ── Status message (default surface) ────────────────────

	private stepStack = new Map<string, Map<string, RunStep[]>>();

	private async startStatus(request: string, starter: RunStarter): Promise<StatusRun> {
		const id = newRunId();
		const chatId = this.chatId;
		const first = "Working on: getting started";
		const messageId = await this.callTelegram("sendMessage", {
			chat_id: chatId,
			text: first,
			reply_markup: runStatusKeyboard(id, { cancel: true, steps: true }),
			disable_web_page_preview: true,
		});
		const run: StatusRun = {
			id,
			chatId,
			threadId: this.resolveThread?.(),
			starter,
			messageId,
			request,
			startedAt: Date.now(),
			state: "running",
			steps: [],
			line: new StatusLine(first, this.statusIntervalMs, (sentence) =>
				this.statusEdit(run, statusText.working(sentence), {
					cancel: true,
					steps: true,
				}),
			),
		};
		return run;
	}

	private async statusEdit(
		run: StatusRun,
		text: string,
		buttons: { cancel: boolean; steps: boolean },
	): Promise<void> {
		const rows = run.finishRows ?? [];
		try {
			await this.callTelegram("editMessageText", {
				chat_id: run.chatId,
				message_id: run.messageId,
				text,
				reply_markup: runStatusKeyboard(run.id, buttons, rows),
				disable_web_page_preview: true,
			});
		} catch (err) {
			// Edits are non-critical; "not modified" is the common benign case.
			void err;
		}
	}

	/** End a run: final edit (Cancel gone, Show steps kept), then start the 24 h retention. */
	private async finishStatus(
		run: StatusRun,
		state: "done" | "stopped" | "failed",
		text: string,
		finishRows: InlineKeyboardMarkup["inline_keyboard"] = [],
	): Promise<void> {
		run.line.close();
		run.state = state;
		run.endedAt = Date.now();
		run.finishRows = finishRows;
		await this.statusEdit(run, text, { cancel: false, steps: true });
		this.stepStack.delete(run.id);
		this.finishedRuns.set(run.id, run);
		const timer = setTimeout(() => void this.expireRun(run), this.stepsRetentionMs);
		(timer as { unref?: () => void }).unref?.();
		run.expiry = timer;
	}

	private async expireRun(run: StatusRun): Promise<void> {
		this.finishedRuns.delete(run.id);
		await this.callTelegram("editMessageReplyMarkup", {
			chat_id: run.chatId,
			message_id: run.messageId,
			// Show steps goes; Continue / New task / Resend files / Retry / Drop stay.
			reply_markup: runStatusKeyboard(
				run.id,
				{ cancel: false, steps: false },
				run.finishRows ?? [],
			),
		}).catch(() => {});
	}

	private findRun(id: string): StatusRun | undefined {
		if (this.current?.status?.id === id) return this.current.status;
		return this.finishedRuns.get(id);
	}

	/**
	 * A Cancel or Show steps tap. Only the person who started the run may press
	 * either; anyone else gets a private notice and nothing happens. A run whose
	 * starter is unknown answers only in a private chat. Operators may also press Cancel on any run. The caller answers the
	 * callback query with the returned text.
	 */
	async handleRunCallback(
		prefix: string,
		runId: string,
		presser: { fromId?: number; chatType?: string; operator?: boolean },
	): Promise<RunCallbackResult> {
		const isCancel = prefix === CB_PREFIX.runCancel;
		const run = this.findRun(runId);
		if (!run) return { text: RUN_GONE, alert: true };
		const known = typeof run.starter.fromId === "number";
		const allowed = known
			? presser.fromId === run.starter.fromId
			: presser.chatType === "private" && run.starter.chatType === "private";
		// An operator (TELEGRAM_OPERATOR_USER_IDS) may stop any run; Show steps stays starter-only.
		if (!allowed && !(isCancel && presser.operator === true))
			return { text: isCancel ? ONLY_STARTER_CANCEL : ONLY_STARTER_STEPS, alert: true };

		if (isCancel) {
			if (run.state !== "running" || this.current?.status?.id !== run.id) {
				return { text: RUN_FINISHED };
			}
			await this.cancelCurrent("Cancelled by user");
			return {};
		}
		return (await this.sendSteps(run))
			? {}
			: { text: "I could not send the steps. Try again.", alert: true };
	}

	/** The full step log as one .txt reply to the status message, built here, sent here. */
	private async sendSteps(run: StatusRun): Promise<boolean> {
		const log = buildStepsLog({
			id: run.id,
			request: run.request,
			startedAt: run.startedAt,
			endedAt: run.endedAt,
			state: run.state,
			steps: run.steps,
			error: run.error,
		});
		const form = new FormData();
		form.append("chat_id", run.chatId);
		if (run.threadId !== undefined) form.append("message_thread_id", String(run.threadId));
		form.append(
			"reply_parameters",
			JSON.stringify({ message_id: run.messageId, allow_sending_without_reply: true }),
		);
		form.append("document", new Blob([log], { type: "text/plain" }), `steps-${run.id}.txt`);
		try {
			const res = await fetch(`${TELEGRAM_API}${this.telegramToken}/sendDocument`, {
				method: "POST",
				body: form,
			});
			const json = (await res.json()) as { ok: boolean };
			return json.ok === true;
		} catch {
			return false;
		}
	}

	// ── Telegram I/O ────────────────────────────────────────

	private runnerEvents(): TaskRunnerEvents {
		return {
			send: (text, replyMarkup) => this.tgSend(text, replyMarkup),
			edit: (id, text, replyMarkup) => this.tgEdit(id, text, replyMarkup),
			sendFile: (att) => this.files.send(att),
		};
	}

	private startTyping(task: RunningTask): void {
		const beat = () => {
			this.callTelegram("sendChatAction", { chat_id: this.chatId, action: "typing" }).catch(
				() => {},
			);
		};
		beat();
		task.typingTimer = setInterval(beat, TYPING_REFRESH_MS);
	}

	private stopTyping(task: RunningTask): void {
		if (task.typingTimer) clearInterval(task.typingTimer);
		task.typingTimer = undefined;
	}

	/** The agent's final text as plain messages. Markdown first; if Telegram rejects it, the same text unformatted. */
	private async sendReply(text: string): Promise<void> {
		for (const chunk of splitIntoChunks(text)) {
			try {
				await this.tgSend(chunk);
			} catch {
				await this.callTelegram("sendMessage", {
					chat_id: this.chatId,
					text: chunk,
					disable_web_page_preview: true,
				}).catch(() => {});
			}
		}
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
		const thread = method === "sendMessage" ? this.resolveThread?.() : undefined;
		if (thread !== undefined) body = { ...body, message_thread_id: thread };
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
