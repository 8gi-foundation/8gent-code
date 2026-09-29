/**
 * Telegram Bridge - Connects Telegram to the daemon's WebSocket gateway.
 *
 * Polls Telegram for messages, routes them to the daemon as prompts,
 * streams events back as Telegram messages. Runs inside the Vessel container
 * alongside the daemon process.
 *
 * This gives Eight full autonomous capability via Telegram:
 * - Natural language prompts (routed to agent with all tools)
 * - /run <cmd> for direct shell execution
 * - /status for daemon health
 * - /deploy for Vercel/Fly deployments
 * - Startup notification: "I'm online. What do we work on next?"
 */

import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient, SessionStore, TelegramBridgeAdapter } from "../telegram-bot";
import {
	BOARD_ROSTER,
	VOICE_BY_OFFICER,
	askOfficerViaClaude,
	askVerdictViaClaude,
	runBoardroom,
} from "../telegram-bot/boardroom";
import { CB_PREFIX, parseCallbackData } from "../telegram-bot/keyboards";
import {
	decideVoice,
	readVoiceState,
	sendVoiceNote,
	writeVoiceState,
} from "../telegram-bot/voice-mode";

/**
 * Where messages from chats the bridge does not answer are recorded.
 * One JSON object per line, appended.
 */
export const OBSERVED_LOG = join(homedir(), ".8gent", "telegram-observed.jsonl");

/** Stop the log growing without bound; ~5MB is weeks of a busy group. */
const OBSERVED_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Record an update from a chat the bridge is not authorized to answer.
 *
 * Deliberately total: every failure path is swallowed. This runs inside the
 * poll loop, and an unhandled throw here would kill polling while leaving the
 * process alive - a bridge that looks healthy in `launchctl` and answers
 * nothing, which is a failure mode this project has already paid for once.
 * Losing an observation is acceptable; losing the poll loop is not.
 *
 * Stores only what a reader needs to follow a conversation. No raw update
 * dump, so nothing incidental in the payload is persisted by accident.
 */
export function observeUnauthorized(update: unknown): void {
	try {
		const u = update as {
			update_id?: number;
			message?: {
				date?: number;
				text?: string;
				caption?: string;
				message_id?: number;
				chat?: { id?: number; title?: string; type?: string };
				from?: { username?: string; first_name?: string; is_bot?: boolean };
			};
		};
		const m = u.message;
		if (!m) return;
		const text = m.text ?? m.caption;
		if (!text) return; // nothing readable (sticker, service message)

		try {
			if (statSync(OBSERVED_LOG).size > OBSERVED_MAX_BYTES) return;
		} catch {
			mkdirSync(join(homedir(), ".8gent"), { recursive: true });
		}

		appendFileSync(
			OBSERVED_LOG,
			`${JSON.stringify({
				at: new Date((m.date ?? 0) * 1000).toISOString(),
				update_id: u.update_id,
				message_id: m.message_id,
				chat_id: m.chat?.id,
				chat_title: m.chat?.title,
				from: m.from?.username ?? m.from?.first_name,
				is_bot: m.from?.is_bot === true,
				text,
			})}\n`,
			"utf8",
		);
	} catch {
		// Never let observation break the bridge.
	}
}

const TELEGRAM_API = "https://api.telegram.org/bot";
const MAX_MSG_LENGTH = 4000;

/** Multi-step mode is on by default. Set EIGHT_TG_LEGACY=1 to fall back. */
const MULTI_STEP_ENABLED = process.env.EIGHT_TG_LEGACY !== "1";
const SESSION_STORE_PATH =
	process.env.EIGHT_TG_SESSIONS || `${process.env.HOME ?? ""}/.8gent/telegram-sessions.json`;

interface TelegramUpdate {
	update_id: number;
	message?: {
		message_id: number;
		from: { id: number; first_name: string; username?: string };
		chat: { id: number; type?: string };
		text?: string;
		voice?: { file_id: string; duration: number };
		audio?: { file_id: string; duration: number };
	};
	callback_query?: {
		id: string;
		from: { id: number };
		data?: string;
		message?: { message_id: number; chat: { id: number; type?: string } };
	};
}

interface BridgeConfig {
	telegramToken: string;
	chatId: string;
	daemonUrl: string; // ws://localhost:18789 (same container)
	authToken?: string;
	devGroupId?: string; // Optional dev group for verbose logs
	/**
	 * Optional explicit chat_id allowlist. Used in local mode so a stolen
	 * bot token can't be used to drive the local daemon from a chat that
	 * isn't James's. When set, ANY chat_id outside the list is rejected
	 * before reaching the agent loop.
	 */
	authorizedChatIds?: string[];
	/**
	 * Optional sender allowlist (Telegram user ids). The chat allowlist names
	 * WHERE the bridge listens; this names WHO may drive it. Required in
	 * practice for any group chat: without it a group fails closed, because a
	 * group is many people and the chat id no longer identifies the operator.
	 */
	authorizedUserIds?: string[];
	/**
	 * Who may press Approve on a tool-permission prompt. A strict subset of
	 * the sender allowlist, and the reason the two lists are separate:
	 * conversation and consent are different powers. Several agents can share
	 * a room and talk to this instance; only the person whose machine runs it
	 * gets to authorise a write on it. Defaults to the first authorised user.
	 */
	operatorUserIds?: string[];
}

async function tgSend(
	token: string,
	chatId: string,
	text: string,
	parseMode = "Markdown",
): Promise<void> {
	// Split long messages
	const chunks: string[] = [];
	let remaining = text;
	while (remaining.length > 0) {
		if (remaining.length <= MAX_MSG_LENGTH) {
			chunks.push(remaining);
			break;
		}
		let splitAt = remaining.lastIndexOf("\n", MAX_MSG_LENGTH);
		if (splitAt < 100) splitAt = MAX_MSG_LENGTH;
		chunks.push(remaining.slice(0, splitAt));
		remaining = remaining.slice(splitAt);
	}

	for (const chunk of chunks) {
		try {
			await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					chat_id: chatId,
					text: chunk,
					...(parseMode ? { parse_mode: parseMode } : {}),
				}),
			});
		} catch {
			// Retry without parse mode if markdown fails
			await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ chat_id: chatId, text: chunk }),
			}).catch(() => {});
		}
	}
}

/**
 * Local whisper.cpp model, largest first. `base.en` transcribes a short voice
 * note in well under a second on Apple Silicon, which is faster than the round
 * trip to any hosted Whisper would be.
 */
const WHISPER_MODELS = [
	`${process.env.HOME}/.8gent/models/whisper/ggml-base.en.bin`,
	`${process.env.HOME}/.8gent/models/whisper/ggml-tiny.bin`,
	`${process.env.HOME}/models/ggml-base.en.bin`,
];

function localWhisperModel(): string | null {
	for (const m of WHISPER_MODELS) {
		if (existsSync(m)) return m;
	}
	return null;
}

/**
 * Download a Telegram voice note and transcribe it LOCALLY with whisper.cpp.
 *
 * This used to POST the audio to Groq or OpenAI and, with no key set, refuse
 * outright with "[set GROQ_API_KEY or OPENAI_API_KEY]" - on a machine that has
 * had whisper.cpp and its models installed the whole time. Two things were
 * wrong with that. It broke voice input for the one user, and it shipped his
 * voice to a third party to do work the laptop does in 0.6s.
 *
 * Local only, deliberately: there is no cloud fallback. A missing model is a
 * setup error worth surfacing, not a reason to start sending audio off-box.
 */
async function transcribeVoice(token: string, fileId: string): Promise<string> {
	const model = localWhisperModel();
	if (!model) {
		return "[no local whisper model found - expected ~/.8gent/models/whisper/ggml-base.en.bin]";
	}

	const fileRes = await fetch(`${TELEGRAM_API}${token}/getFile`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ file_id: fileId }),
	});
	const fileData = await fileRes.json();
	if (!fileData.ok || !fileData.result?.file_path) {
		return "[could not download voice message]";
	}

	const audioUrl = `https://api.telegram.org/file/bot${token}/${fileData.result.file_path}`;
	const audioRes = await fetch(audioUrl);
	const audioBuffer = await audioRes.arrayBuffer();

	const stem = join(tmpdir(), `tg-voice-${Date.now()}-${Math.floor(performance.now())}`);
	const ogg = `${stem}.ogg`;
	const wav = `${stem}.wav`;
	try {
		writeFileSync(ogg, Buffer.from(audioBuffer));
		// whisper.cpp wants 16 kHz mono PCM; Telegram sends OPUS in an OGG container.
		const conv = spawnSync("ffmpeg", ["-y", "-i", ogg, "-ar", "16000", "-ac", "1", wav], {
			encoding: "utf8",
			timeout: 30_000,
		});
		if (conv.status !== 0 || !existsSync(wav)) {
			console.error("[telegram-bridge] ffmpeg failed:", conv.stderr?.slice(-400));
			return "[voice message received - could not decode the audio]";
		}
		// -nt drops timestamps, -np drops the progress banner, so stdout is the
		// transcript and nothing else.
		const out = spawnSync("whisper-cli", ["-m", model, "-f", wav, "-nt", "-np"], {
			encoding: "utf8",
			timeout: 120_000,
		});
		const text = (out.stdout || "").trim();
		if (out.status !== 0 || !text) {
			console.error("[telegram-bridge] whisper failed:", out.stderr?.slice(-400));
			return "[voice message received - transcription failed, please send as text]";
		}
		return text;
	} catch (err) {
		console.error("[telegram-bridge] transcription failed:", err);
		return "[voice message received - transcription failed, please send as text]";
	} finally {
		for (const f of [ogg, wav]) {
			try {
				if (existsSync(f)) unlinkSync(f);
			} catch {}
		}
	}
}

async function tgTyping(token: string, chatId: string): Promise<void> {
	await fetch(`${TELEGRAM_API}${token}/sendChatAction`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chat_id: chatId, action: "typing" }),
	}).catch(() => {});
}

/**
 * The chat-id allowlist. This is the bridge's authentication boundary and the
 * whole reason the `telegram` channel is trusted with full dispatch
 * capabilities in `packages/permissions/dispatch-policy.ts`. It is a pure
 * function so that boundary can be tested directly, without standing up a
 * bridge and a websocket to ask it one question.
 *
 * Fails closed in both directions: an explicit allowlist is authoritative,
 * and with no allowlist configured only the single configured chat id is
 * accepted. There is no "empty means allow all" branch, and there must never
 * be one.
 */
export function isChatAuthorized(
	chatId: number,
	config: { authorizedChatIds?: string[]; chatId: string },
): boolean {
	const incoming = String(chatId);
	const allowlist = config.authorizedChatIds;
	if (allowlist && allowlist.length > 0) {
		return allowlist.includes(incoming);
	}
	return incoming === config.chatId;
}

/**
 * The sender allowlist. Companion to `isChatAuthorized`, same contract: pure,
 * fails closed, no "empty means allow all" branch for groups.
 *
 * - With an allowlist, only listed user ids may drive the bridge, anywhere.
 * - Without one, a private chat keeps today's behaviour: one chat is one
 *   person, so the chat allowlist already names the sender.
 * - Without one, a group or supergroup rejects every sender. Putting a bot
 *   with full dispatch capability in a group and letting anyone in it press
 *   Approve is exactly the hole the dispatch policy assumes cannot exist.
 *
 * `chatType` undefined is treated as private for callers that predate
 * Telegram's `chat.type` being read; Telegram itself always sends it.
 */
export function isSenderAuthorized(
	input: { chatType?: string; fromId?: number },
	config: { authorizedUserIds?: string[] },
): boolean {
	const allowlist = config.authorizedUserIds;
	if (allowlist && allowlist.length > 0) {
		return typeof input.fromId === "number" && allowlist.includes(String(input.fromId));
	}
	const type = input.chatType ?? "private";
	return type === "private";
}

// Import CoS router lazily to avoid circular deps
const CoSRouterClass: typeof import("./cos-router").CoSRouter | null = null;

class TelegramDaemonBridge {
	private config: BridgeConfig;
	private ws: WebSocket | null = null;
	private sessionId: string | null = null;
	private lastUpdateId = 0;
	private polling = false;
	private agentReady = false;
	private agentBusy = false;
	private pendingApprovals = new Map<string, { tool: string; input: unknown; chatId: string }>();
	private cosRouter: InstanceType<typeof import("./cos-router").CoSRouter> | null = null;

	// Multi-step task runtime (issue #1906 / #1913).
	private multiStepEnabled: boolean = MULTI_STEP_ENABLED;
	private daemonClient: DaemonClient | null = null;
	private adapter: TelegramBridgeAdapter | null = null;
	private sessionStore: SessionStore | null = null;

	/** Voice mode toggle, restored from disk at construction so it survives a restart. */
	private voiceEnabled: boolean = readVoiceState().enabled;
	/** One boardroom run at a time. */
	private boardroomRunning = false;

	constructor(config: BridgeConfig) {
		this.config = config;
	}

	async start(): Promise<void> {
		console.log("[telegram-bridge] starting...");

		// Connect to daemon WebSocket
		await this.connectDaemon();

		// Multi-step task adapter sits on top of the same connection. We open
		// a parallel DaemonClient so the adapter manages its own session;
		// legacy single-shot prompts continue to use `this.ws`.
		if (this.multiStepEnabled) {
			try {
				this.daemonClient = new DaemonClient({
					url: this.config.daemonUrl,
					authToken: this.config.authToken,
					channel: "telegram",
				});
				await this.daemonClient.connect();
				this.sessionStore = new SessionStore({ persistPath: SESSION_STORE_PATH });
				this.adapter = new TelegramBridgeAdapter({
					telegramToken: this.config.telegramToken,
					resolveChatId: () => this.replyChat(),
					daemon: this.daemonClient,
					sessionStore: this.sessionStore,
					onFinalReply: (text) => this.maybeSpeak(text),
				});
				console.log("[telegram-bridge] multi-step task adapter attached");
			} catch (err) {
				console.error("[telegram-bridge] multi-step adapter failed, falling back:", err);
				this.multiStepEnabled = false;
				this.daemonClient?.close();
				this.daemonClient = null;
			}
		}

		// Initialize CoS router for CEO command handling
		try {
			const { CoSRouter } = await import("./cos-router");
			const { NotificationDispatcher } = await import("./notifications");
			const { AgentPool } = await import("./agent-pool");

			// Get the pool from the daemon (create a separate one for delegations)
			const cosPool = new AgentPool({
				model: process.env.DEFAULT_MODEL || "auto:free",
				runtime: (process.env.DEFAULT_RUNTIME as any) || "openrouter",
				workingDirectory: process.env.HOME ? `${process.env.HOME}/.8gent/workspace` : "/app",
				apiKey: process.env.OPENROUTER_API_KEY,
			});

			const notifications = new NotificationDispatcher(
				this.config.telegramToken,
				this.config.chatId,
				this.config.devGroupId,
			);

			this.cosRouter = new CoSRouter({ pool: cosPool, notifications });
			console.log("[telegram-bridge] CoS router initialized");
		} catch (err) {
			console.error("[telegram-bridge] CoS router failed to initialize:", err);
		}

		// Send startup message (direct to Telegram, not through agent)
		const mode = this.multiStepEnabled ? "multi-step" : "legacy";
		await tgSend(
			this.config.telegramToken,
			this.config.chatId,
			`Eight is online (${mode} mode). Commands: /delegate, /status, /cancel, /review, /plan, /goals\n\nWhat do we work on next?`,
		);

		// Wait for agent to finish initializing (AST indexing takes ~5s)
		console.log("[telegram-bridge] waiting for agent initialization...");
		await new Promise((r) => setTimeout(r, 8000));
		this.agentReady = true;
		console.log("[telegram-bridge] agent ready, accepting messages");

		// Keep session alive with periodic pings (prevent 30min idle eviction)
		setInterval(
			() => {
				if (this.ws && this.ws.readyState === WebSocket.OPEN) {
					this.ws.send(JSON.stringify({ type: "ping" }));
				}
			},
			10 * 60 * 1000,
		); // Every 10 minutes

		// Start Telegram polling
		this.polling = true;
		this.poll();

		console.log("[telegram-bridge] ready - polling Telegram, connected to daemon");
	}

	private async connectDaemon(): Promise<void> {
		return new Promise((resolve, reject) => {
			const url = this.config.daemonUrl;
			console.log(`[telegram-bridge] connecting to daemon at ${url}`);

			this.ws = new WebSocket(url);

			this.ws.onopen = () => {
				console.log("[telegram-bridge] daemon connected");

				// Auth if needed
				if (this.config.authToken) {
					this.ws?.send(JSON.stringify({ type: "auth", token: this.config.authToken }));
				}

				// Create a session
				this.ws?.send(JSON.stringify({ type: "session:create", channel: "telegram" }));
			};

			this.ws.onmessage = (event: MessageEvent) => {
				const msg = JSON.parse(
					typeof event.data === "string"
						? event.data
						: new TextDecoder().decode(event.data as ArrayBuffer),
				);
				this.handleDaemonMessage(msg);

				// Resolve on session creation
				if (msg.type === "session:created") {
					this.sessionId = msg.sessionId;
					console.log(`[telegram-bridge] session ${this.sessionId}`);
					resolve();
				}
			};

			this.ws.onerror = (err) => {
				console.error("[telegram-bridge] daemon connection error:", err);
				reject(err);
			};

			this.ws.onclose = () => {
				console.log("[telegram-bridge] daemon disconnected, reconnecting in 5s...");
				setTimeout(() => this.connectDaemon().catch(console.error), 5000);
			};
		});
	}

	private handleDaemonMessage(msg: any): void {
		if (msg.type !== "event") return;

		const { event, payload } = msg;

		switch (event) {
			case "agent:stream":
				if (payload.final && payload.chunk) {
					this.agentBusy = false;
					if (this._retryTimer) {
						clearTimeout(this._retryTimer);
						this._retryTimer = null;
					}
					tgSend(this.config.telegramToken, this.replyChat(), payload.chunk);
					this.maybeSpeak(payload.chunk).catch(() => {});
				}
				break;

			case "agent:error":
				this.agentBusy = false;
				if (this._retryTimer) {
					clearTimeout(this._retryTimer);
					this._retryTimer = null;
				}
				// If session was evicted, recreate it silently
				if (payload.error === "session not found") {
					console.log("[telegram-bridge] session evicted, recreating...");
					this.ws?.send(JSON.stringify({ type: "session:create", channel: "telegram" }));
					return;
				}
				tgSend(this.config.telegramToken, this.replyChat(), `Error: ${payload.error}`);
				break;

			case "session:end":
				this.agentBusy = false;
				if (this._retryTimer) {
					clearTimeout(this._retryTimer);
					this._retryTimer = null;
				}
				break;

			case "approval:required":
				// NemoClaw-style operator approval via Telegram
				this.sendApprovalRequest(payload);
				break;

			case "tool:start":
				tgTyping(this.config.telegramToken, this.replyChat());
				break;
		}
	}

	private async poll(): Promise<void> {
		while (this.polling) {
			try {
				const res = await fetch(
					`${TELEGRAM_API}${this.config.telegramToken}/getUpdates?offset=${this.lastUpdateId + 1}&timeout=30`,
					{ signal: AbortSignal.timeout(35000) },
				);
				const data = await res.json();

				if (data.ok && data.result) {
					for (const update of data.result as TelegramUpdate[]) {
						this.lastUpdateId = update.update_id;
						// Drop messages from unauthorized chats before any side effect
						// (transcription, typing indicators, agent dispatch).
						// Note this only covers `update.message`. Callback queries carry
						// no message and are checked in handleCallbackQuery instead.
						const incomingChatId = update.message?.chat?.id;
						if (typeof incomingChatId === "number" && !this.isAuthorizedChat(incomingChatId)) {
							// Record before dropping. The bot is an administrator of
							// groups it does not answer in, so it already receives every
							// message there, and Telegram gives bots no history API - once
							// this update is discarded that content cannot be recovered.
							// The bridge also holds the only getUpdates lease on the token,
							// so a second poller would conflict with it rather than read
							// alongside it. Appending here is the one place another process
							// can learn what was said without contending for the lease.
							//
							// Capture only. The allowlist keeps its exact meaning: this chat
							// still gets no reply, no agent dispatch and no side effect.
							observeUnauthorized(update);
							console.warn(
								`[telegram-bridge] observed and dropped update from unauthorized chat ${incomingChatId}`,
							);
							continue;
						}
						// Second gate, same shape as the first: WHO sent it. Callback
						// queries carry no update.message and are checked inside
						// handleCallbackQuery, like the chat check.
						if (
							update.message &&
							!this.isAuthorizedSender(update.message.chat?.type, update.message.from?.id)
						) {
							await this.refuseSender(update.message.chat.id, update.message.from?.id);
							continue;
						}
						if (update.callback_query) {
							await this.handleCallbackQuery(update.callback_query);
						} else if (update.message?.voice || update.message?.audio) {
							// Voice/audio message - transcribe then process
							const fileId = update.message.voice?.file_id || update.message.audio?.file_id;
							if (fileId && update.message.chat) {
								this.originChatId = String(update.message.chat.id);
								await tgTyping(this.config.telegramToken, this.replyChat());
								const transcript = await transcribeVoice(this.config.telegramToken, fileId);
								console.log(`[telegram-bridge] voice transcription: "${transcript.slice(0, 100)}"`);
								if (!transcript.startsWith("[")) {
									await tgSend(
										this.config.telegramToken,
										this.replyChat(),
										`Heard: "${transcript}"`,
									);
									await this.handleTelegramMessage(transcript, update.message.chat.id);
								} else {
									await tgSend(this.config.telegramToken, this.replyChat(), transcript);
								}
							}
						} else if (update.message?.text) {
							await this.handleTelegramMessage(update.message.text, update.message.chat.id);
						}
					}
				}
			} catch (err) {
				// Timeout or network error - just retry
				if (String(err).includes("abort")) continue;
				console.error("[telegram-bridge] poll error:", err);
				await new Promise((r) => setTimeout(r, 2000));
			}
		}
	}

	/**
	 * The chat of the turn currently in flight, or null when idle.
	 *
	 * The daemon wire format carries no chat id: the prompt goes out as
	 * `{type:"prompt",text}` and the reply comes back as `{sessionId,chunk}`,
	 * so by the time an answer arrives there is nothing in it that says where
	 * it came from. Before this field every outbound used `config.chatId`, the
	 * first allowlisted chat, which is correct only while the bridge serves
	 * exactly one chat. With a group and a private chat allowlisted together,
	 * a message sent in one was answered in the other.
	 *
	 * A single field is sound rather than racy because the bridge already
	 * serialises turns: `agentBusy` (set before dispatch, cleared on the
	 * terminal daemon event) admits one prompt at a time, so there is only
	 * ever one origin to remember.
	 */
	private originChatId: string | null = null;

	/** Who may approve a tool call: the explicit operators, else the first sender. */
	private isOperator(fromId: number | undefined): boolean {
		const ops =
			this.config.operatorUserIds && this.config.operatorUserIds.length > 0
				? this.config.operatorUserIds
				: this.config.authorizedUserIds?.slice(0, 1);
		if (!ops || ops.length === 0) return true; // single-operator private chat, as before
		return typeof fromId === "number" && ops.includes(String(fromId));
	}

	/** Where this turn's output belongs: the originating chat, else the primary. */
	private replyChat(): string {
		return this.originChatId ?? this.replyChat();
	}

	private isAuthorizedSender(chatType: string | undefined, fromId: number | undefined): boolean {
		return isSenderAuthorized(
			{ chatType, fromId },
			{ authorizedUserIds: this.config.authorizedUserIds },
		);
	}

	/** One refusal per sender per hour, so a group cannot use the bot as an echo. */
	private refusedSenders = new Map<number, number>();
	private async refuseSender(chatId: number, fromId: number | undefined): Promise<void> {
		console.warn(
			`[telegram-bridge] rejected message from unauthorized sender ${fromId ?? "unknown"} in chat ${chatId}`,
		);
		if (typeof fromId !== "number") return;
		const last = this.refusedSenders.get(fromId) ?? 0;
		if (Date.now() - last < 60 * 60 * 1000) return;
		this.refusedSenders.set(fromId, Date.now());
		await tgSend(
			this.config.telegramToken,
			String(chatId),
			"This 8gent instance answers only its operator.",
			"",
		).catch(() => {});
	}

	private isAuthorizedChat(chatId: number): boolean {
		// The CONFIGURED chat, never replyChat(): this is the authorization
		// boundary, and an in-flight origin must never be able to authorize
		// itself. With no allowlist, the single configured chat is the rule.
		return isChatAuthorized(chatId, {
			authorizedChatIds: this.config.authorizedChatIds,
			chatId: this.config.chatId,
		});
	}

	private async handleTelegramMessage(text: string, chatId: number): Promise<void> {
		// Only respond to authorized chats. In local mode this is the
		// hard boundary that prevents a leaked token from driving the
		// daemon from a chat that isn't James's.
		if (!this.isAuthorizedChat(chatId)) {
			console.warn(`[telegram-bridge] rejected message from unauthorized chat ${chatId}`);
			return;
		}

		// From here until the daemon's terminal event, this turn's output
		// belongs to this chat. Set before the first typing indicator so even
		// that lands in the right room.
		this.originChatId = String(chatId);

		// Show typing
		await tgTyping(this.config.telegramToken, this.replyChat());

		// CEO commands via CoS router (delegate, plan, review, goals, kill)
		if (this.cosRouter) {
			const handled = await this.cosRouter.handleCommand(text, chatId);
			if (handled) return;
		}

		// Handle built-in commands
		if (text === "/logs") {
			try {
				const { execSync } = await import("node:child_process");
				const logs = execSync(
					"tail -30 /root/.8gent/daemon.log 2>/dev/null || echo 'No log file'",
					{ encoding: "utf-8", timeout: 5000 },
				);
				await tgSend(
					this.config.telegramToken,
					this.replyChat(),
					`*Recent Logs*\n\`\`\`\n${logs.slice(-3000)}\n\`\`\``,
				);
			} catch {
				await tgSend(this.config.telegramToken, this.replyChat(), "Could not read logs.");
			}
			return;
		}

		if (text === "/unstick") {
			this.agentBusy = false;
			if (this.adapter) {
				await this.adapter.cancelCurrent("Reset by /unstick").catch(() => {});
			}
			await tgSend(
				this.config.telegramToken,
				this.replyChat(),
				"Cleared busy state. Ready for new messages.",
			);
			return;
		}

		if (text === "/cancel") {
			if (this.adapter) {
				const cancelled = await this.adapter.cancelCurrent();
				await tgSend(
					this.config.telegramToken,
					this.replyChat(),
					cancelled ? "Task cancelled." : "Nothing to cancel.",
				);
			} else {
				this.agentBusy = false;
				await tgSend(this.config.telegramToken, this.replyChat(), "Reset (legacy mode).");
			}
			return;
		}

		if (text.startsWith("/status")) {
			try {
				const res = await fetch(
					`${this.config.daemonUrl
						.replace("ws", "http")
						.replace("wss", "https")
						.replace(/:\d+/, ":18789")}/health`,
				);
				const health = await res.json();
				await tgSend(
					this.config.telegramToken,
					this.replyChat(),
					`*Eight Status*\nSessions: ${health.sessions}\nUptime: ${Math.round(health.uptime)}s\nStatus: ${health.status}`,
				);
			} catch {
				await tgSend(
					this.config.telegramToken,
					this.replyChat(),
					"Could not reach daemon health endpoint.",
				);
			}
			return;
		}

		if (text.startsWith("/voice")) {
			await this.handleVoiceCommand(text.slice("/voice".length).trim().toLowerCase());
			return;
		}

		if (text.startsWith("/boardroom")) {
			await this.handleBoardroom(text.slice("/boardroom".length).trim());
			return;
		}

		if (text === "/help") {
			await tgSend(
				this.config.telegramToken,
				this.replyChat(),
				[
					"*Eight - Telegram Bridge*",
					"",
					"Send any message, or a voice note, to start a multi-step task.",
					"",
					"/boardroom <topic> - all 8 officers deliberate, one message, one verdict",
					"/voice on|off - replies also arrive as a voice note (quiet 21:00-08:30)",
					"/voice - show the current voice setting",
					"/status - Daemon health",
					"/cancel - Stop the current task",
					"/unstick - Reset busy state",
					"/delegate, /plan, /review, /goals, /kill - chief-of-staff commands",
					"/logs - Tail daemon logs",
					"/help - This message",
					"",
					"Your standing rules from ~/.claude/CLAUDE.md load on every turn. You do not have to ask for them.",
				].join("\n"),
			);
			return;
		}

		// Multi-step path: TaskRunner adapter owns the response message, edits
		// it as steps complete, and sends final files automatically.
		if (this.multiStepEnabled && this.adapter) {
			try {
				await this.adapter.handleUserMessage(text);
			} catch (err) {
				console.error("[telegram-bridge] adapter error, falling back to legacy:", err);
				await tgSend(
					this.config.telegramToken,
					this.replyChat(),
					`Adapter error: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			return;
		}

		// Legacy single-shot path (EIGHT_TG_LEGACY=1).
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			await tgSend(
				this.config.telegramToken,
				this.replyChat(),
				"Daemon not connected. Reconnecting...",
			);
			await this.connectDaemon().catch(() => {});
			return;
		}

		if (this.agentBusy) {
			await tgSend(
				this.config.telegramToken,
				this.replyChat(),
				"Still working on the previous request. I'll get to this next.",
			);
			return;
		}

		this.agentBusy = true;
		this.retryPrompt(text, 1);
	}

	// ── Voice mode ───────────────────────────────────────────────────

	/** `/voice`, `/voice on`, `/voice off`. Anything else prints the usage. */
	private async handleVoiceCommand(arg: string): Promise<void> {
		const send = (msg: string) => tgSend(this.config.telegramToken, this.replyChat(), msg);
		if (arg === "on" || arg === "off") {
			const state = writeVoiceState(arg === "on");
			this.voiceEnabled = state.enabled;
			await send(
				state.enabled
					? "Voice mode on. Replies come back as a voice note too, unless it is quiet hours or the answer is too long to be worth hearing."
					: "Voice mode off. Text only.",
			);
			return;
		}
		if (arg.length === 0) {
			const state = readVoiceState();
			this.voiceEnabled = state.enabled;
			await send(`Voice mode is ${state.enabled ? "on" : "off"}. Use /voice on or /voice off.`);
			return;
		}
		await send("Usage: /voice on, /voice off, or /voice to see the current setting.");
	}

	/**
	 * Speak a reply if voice mode says so. The text has already been sent, so
	 * every path here is best-effort and silent on failure: a broken audio
	 * stack must never cost him the answer.
	 */
	private async maybeSpeak(text: string, voice = VOICE_BY_OFFICER.James): Promise<void> {
		const decision = decideVoice(text, { enabled: this.voiceEnabled });
		if (!decision.speak) {
			if (decision.reason !== "voice-mode-off") {
				console.log(`[telegram-bridge] not speaking (${decision.reason})`);
			}
			return;
		}
		const result = await sendVoiceNote({
			text: decision.text,
			voice,
			expectedChatId: this.replyChat(),
		});
		if (!result.sent) console.error(`[telegram-bridge] voice note failed: ${result.reason}`);
	}

	// ── Boardroom ────────────────────────────────────────────────────

	/**
	 * `/boardroom <topic>` - the full eight-officer fan-out.
	 *
	 * One message for the whole run, edited in place. He can lock the phone.
	 * Only one run at a time: eight concurrent officer processes is already the
	 * machine's ceiling, and two overlapping runs would fight over the same
	 * message shape with no way to tell them apart in the chat.
	 */
	private async handleBoardroom(topic: string): Promise<void> {
		const send = (msg: string) => tgSend(this.config.telegramToken, this.replyChat(), msg);
		if (!topic) {
			await send("Usage: /boardroom <topic>. All 8 officers report, then one verdict.");
			return;
		}
		if (this.boardroomRunning) {
			await send("A boardroom run is already in flight. Wait for the verdict.");
			return;
		}
		this.boardroomRunning = true;
		const cwd = process.cwd();
		let messageId: number | null = null;

		try {
			const result = await runBoardroom(topic, {
				askOfficer: askOfficerViaClaude(cwd),
				askVerdict: askVerdictViaClaude(cwd),
				sendMessage: async (body) => {
					messageId = await this.sendTracked(body);
				},
				editMessage: async (body) => {
					if (messageId !== null) await this.editTracked(messageId, body);
				},
			});
			console.log(
				`[telegram-bridge] boardroom done: ${result.rows.filter((r) => r.status === "done").length}/${BOARD_ROSTER.length} in ${Math.round(result.elapsedMs / 1000)}s, ${result.edits} edits`,
			);
			if (result.verdict) await this.maybeSpeak(`Boardroom verdict. ${result.verdict}`);
		} catch (err) {
			console.error("[telegram-bridge] boardroom failed:", err);
			await send(`Boardroom failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			this.boardroomRunning = false;
		}
	}

	/** Send one message and return its id, so it can be edited in place. */
	private async sendTracked(text: string): Promise<number | null> {
		try {
			const res = await fetch(`${TELEGRAM_API}${this.config.telegramToken}/sendMessage`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					chat_id: this.replyChat(),
					text,
					parse_mode: "Markdown",
					disable_web_page_preview: true,
				}),
			});
			const data = await res.json();
			return data?.result?.message_id ?? null;
		} catch (err) {
			console.error("[telegram-bridge] sendTracked failed:", err);
			return null;
		}
	}

	/** Edit that one message. "not modified" is expected and not an error. */
	private async editTracked(messageId: number, text: string): Promise<void> {
		await fetch(`${TELEGRAM_API}${this.config.telegramToken}/editMessageText`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				chat_id: this.replyChat(),
				message_id: messageId,
				text,
				parse_mode: "Markdown",
				disable_web_page_preview: true,
			}),
		}).catch(() => {});
	}

	/**
	 * Retry loop: tries the prompt up to 4 times with different strategies.
	 * The Infinite Gentleman never gives up.
	 *
	 * Attempt 1: Send as-is (2 min timeout)
	 * Attempt 2: Simplify - prepend "Answer briefly without using tools: " (90s timeout)
	 * Attempt 3: Direct - prepend "In one paragraph, no tools: " (60s timeout)
	 * Attempt 4: Fallback - acknowledge the issue and ask for simpler request
	 */
	private retryPrompt(originalText: string, attempt: number): void {
		const maxAttempts = 4;
		const timeouts = [120_000, 90_000, 60_000, 30_000];
		const timeout = timeouts[attempt - 1] || 30_000;

		let prompt = originalText;
		if (attempt === 2) {
			prompt = `Answer briefly and concisely. Limit tool use to 5 calls maximum. Original question: ${originalText}`;
			tgSend(
				this.config.telegramToken,
				this.replyChat(),
				"Taking a bit longer than expected. Trying a simpler approach...",
			);
		} else if (attempt === 3) {
			prompt = `Respond in one short paragraph. Do NOT use any tools. Just answer from what you know. Question: ${originalText}`;
			tgSend(
				this.config.telegramToken,
				this.replyChat(),
				"Still working on it. Trying without tools this time...",
			);
		} else if (attempt >= 4) {
			// Final fallback - just acknowledge
			this.agentBusy = false;
			tgSend(
				this.config.telegramToken,
				this.replyChat(),
				"I tried 3 different approaches but couldn't complete this one. Could you rephrase or break it into a smaller task? I'm ready for the next message.",
			);
			return;
		}

		// Send the prompt
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify({ type: "prompt", text: prompt }));
		}

		// Set timeout for this attempt
		const timer = setTimeout(() => {
			if (this.agentBusy) {
				// Create a new session to clear any stuck state
				if (this.ws && this.ws.readyState === WebSocket.OPEN) {
					this.ws.send(JSON.stringify({ type: "session:create", channel: "telegram" }));
				}
				// Retry with next strategy
				this.retryPrompt(originalText, attempt + 1);
			}
		}, timeout);

		// Clear the timer if we get a response (handled by agentBusy being set to false)
		this._retryTimer = timer;
	}

	private _retryTimer: ReturnType<typeof setTimeout> | null = null;

	private async sendApprovalRequest(payload: any): Promise<void> {
		const { requestId, tool, input } = payload;
		this.pendingApprovals.set(requestId, { tool, input, chatId: this.replyChat() });

		const inputPreview =
			typeof input === "string" ? input.slice(0, 200) : JSON.stringify(input).slice(0, 200);

		try {
			await fetch(`${TELEGRAM_API}${this.config.telegramToken}/sendMessage`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					chat_id: this.replyChat(),
					text: `*Permission Required*\n\nTool: \`${tool}\`\nAction: ${inputPreview}`,
					parse_mode: "Markdown",
					reply_markup: {
						inline_keyboard: [
							[
								{ text: "Approve", callback_data: `approve:${requestId}` },
								{ text: "Deny", callback_data: `deny:${requestId}` },
							],
						],
					},
				}),
			});
		} catch (err) {
			console.error("[telegram-bridge] failed to send approval request:", err);
		}
	}

	/**
	 * Strip the inline keyboard off a message once its choice has been made.
	 * Without this a resolved choice point keeps its buttons, which reads as
	 * "nothing happened" and invites the same tap again.
	 */
	private async clearKeyboard(messageId?: number): Promise<void> {
		if (!messageId) return;
		await fetch(`${TELEGRAM_API}${this.config.telegramToken}/editMessageReplyMarkup`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				chat_id: this.replyChat(),
				message_id: messageId,
				reply_markup: { inline_keyboard: [] },
			}),
		}).catch(() => {});
	}

	private async handleCallbackQuery(
		query: NonNullable<TelegramUpdate["callback_query"]>,
	): Promise<void> {
		// Inline-keyboard buttons are a control surface: approve or deny a
		// permission prompt, cancel a running task, drop conversation context.
		// They arrive as `callback_query` updates, which carry no
		// `update.message`, so the poll loop's allowlist check reads
		// `update.message?.chat?.id` as undefined and waves them through, and
		// `handleTelegramMessage` never sees them at all. That made buttons the
		// one inbound path with no chat-id check on it.
		//
		// Reaching it required the bot to have posted a keyboard into the
		// attacker's chat, which it does not do, so this was a latent hole
		// rather than a live one. It is closed here because the dispatch policy
		// now cites this handler as one of the three checks that justify
		// trusting the channel, and a cited control has to actually exist.
		//
		// Fails closed: a callback with no originating chat is rejected.
		const originChatId = query.message?.chat?.id;
		if (typeof originChatId !== "number" || !this.isAuthorizedChat(originChatId)) {
			console.warn(
				`[telegram-bridge] rejected callback query from unauthorized chat ${originChatId ?? "unknown"}`,
			);
			return;
		}

		// A tap is a turn of its own: everything it triggers belongs here.
		this.originChatId = String(originChatId);

		if (!this.isAuthorizedSender(query.message?.chat?.type, query.from?.id)) {
			console.warn(
				`[telegram-bridge] rejected callback query from unauthorized sender ${query.from?.id ?? "unknown"} in chat ${originChatId}`,
			);
			return;
		}

		const data = query.data || "";
		// Consent is narrower than conversation: an allowlisted agent may be
		// mid-exchange in this room and still have no business approving a
		// tool call on the operator's machine.
		if (data.startsWith("approve:") || data.startsWith("deny:")) {
			if (!this.isOperator(query.from?.id)) {
				console.warn(
					`[telegram-bridge] rejected approval decision from non-operator ${query.from?.id ?? "unknown"}`,
				);
				await fetch(`${TELEGRAM_API}${this.config.telegramToken}/answerCallbackQuery`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						callback_query_id: query.id,
						text: "Only the operator can approve tool use.",
						show_alert: true,
					}),
				}).catch(() => {});
				return;
			}
		}
		const { prefix, payload } = parseCallbackData(data);
		const requestId = payload || data.split(":")[1] || "";

		// Answer the callback to remove the loading spinner
		await fetch(`${TELEGRAM_API}${this.config.telegramToken}/answerCallbackQuery`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ callback_query_id: query.id }),
		}).catch(() => {});

		// Multi-step task action callbacks (cancel / retry / continue / new / files).
		if (this.adapter) {
			if (prefix === CB_PREFIX.taskCancel) {
				await this.adapter.cancelCurrent();
				return;
			}
			if (prefix === CB_PREFIX.taskRetry) {
				await this.adapter.retryCurrent();
				return;
			}
			if (prefix === CB_PREFIX.taskContinue || prefix === CB_PREFIX.taskNew) {
				// Both buttons used to do the same nothing: reply with a line of
				// text and leave the keyboard on screen. Tapping changed no state,
				// so the choice point never resolved and there was no way past it.
				// Now the keyboard is cleared on tap, and the two buttons actually
				// differ - "New task" drops the conversation context.
				await this.clearKeyboard(query.message?.message_id);
				if (prefix === CB_PREFIX.taskNew) {
					this.sessionId = null;
					this.ws?.send(JSON.stringify({ type: "session:create", channel: "telegram" }));
					await tgSend(
						this.config.telegramToken,
						this.replyChat(),
						"Fresh start. Previous context dropped. What do you need?",
					);
				} else {
					await tgSend(
						this.config.telegramToken,
						this.replyChat(),
						"Still here, context kept. Go on.",
					);
				}
				return;
			}
		}

		const action = prefix;
		if (!requestId || !this.pendingApprovals.has(requestId)) {
			return;
		}

		const approval = this.pendingApprovals.get(requestId)!;
		// An approval belongs to the chat that was asked. With several chats
		// allowlisted, being in ANY of them is not permission to answer a
		// prompt raised in another one.
		if (approval.chatId !== String(originChatId)) {
			console.warn(
				`[telegram-bridge] rejected callback for a prompt raised in another chat (${approval.chatId})`,
			);
			return;
		}
		this.pendingApprovals.delete(requestId);

		const approved = action === "approve";
		const statusText = approved ? "Approved" : "Denied";

		// Update the message to show the decision
		if (query.message) {
			await fetch(`${TELEGRAM_API}${this.config.telegramToken}/editMessageText`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					chat_id: query.message.chat.id,
					message_id: query.message.message_id,
					text: `*${statusText}:* \`${approval.tool}\``,
					parse_mode: "Markdown",
				}),
			}).catch(() => {});
		}

		// Send the approval decision back to the daemon
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(
				JSON.stringify({
					type: "approval:response",
					requestId,
					approved,
				}),
			);
		}
	}

	stop(): void {
		this.polling = false;
		this.adapter?.close();
		this.adapter = null;
		this.daemonClient?.close();
		this.daemonClient = null;
		this.sessionStore?.flush();
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}
	}
}

/** Comma-separated env list to trimmed, non-empty strings. */
function splitIds(raw: string | undefined): string[] {
	return (raw || "")
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

// ── Local-mode programmatic launcher ─────────────────────────────────

/**
 * Start the Telegram bridge wired against the local-mode daemon.
 *
 * Reads:
 *   - TELEGRAM_BOT_TOKEN              required
 *   - TELEGRAM_AUTHORIZED_CHAT_IDS    required, comma-separated allowlist
 *
 * Always connects to ws://127.0.0.1:<port> regardless of DAEMON_URL, so a
 * stale Fly URL in the env can't accidentally redirect a local bridge to
 * a remote vessel.
 *
 * Throws on missing env so the daemon launcher can surface the failure
 * loudly rather than silently running an unauthenticated bridge.
 */
export async function startLocalTelegramBridge(opts: {
	port: number;
}): Promise<TelegramDaemonBridge> {
	const token = process.env.TELEGRAM_BOT_TOKEN;
	if (!token) {
		throw new Error("TELEGRAM_BOT_TOKEN is required to start the local Telegram bridge");
	}
	const allowlistRaw = process.env.TELEGRAM_AUTHORIZED_CHAT_IDS || "";
	const authorizedChatIds = allowlistRaw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	if (authorizedChatIds.length === 0) {
		throw new Error("TELEGRAM_AUTHORIZED_CHAT_IDS must list at least one chat_id for local mode");
	}
	// The first allowlisted chat is the default destination for outbound
	// messages. Inbound messages from any chat in the allowlist are
	// accepted; everything else is dropped in handleTelegramMessage.
	const primaryChatId = authorizedChatIds[0];

	const bridge = new TelegramDaemonBridge({
		telegramToken: token,
		chatId: primaryChatId,
		daemonUrl: `ws://127.0.0.1:${opts.port}`,
		authToken: process.env.DAEMON_AUTH_TOKEN,
		devGroupId: process.env.TELEGRAM_DEV_GROUP_ID,
		authorizedChatIds,
		authorizedUserIds: splitIds(process.env.TELEGRAM_AUTHORIZED_USER_IDS),
		operatorUserIds: splitIds(process.env.TELEGRAM_OPERATOR_USER_IDS),
	});
	await bridge.start();
	return bridge;
}

export { TelegramDaemonBridge };

// ── Entry point ──────────────────────────────────────────────────────

if (import.meta.main) {
	// BOT_NAME selects which env-var pair holds this bridge's credentials.
	// "aijames" (default) reads TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID — existing
	// behaviour. "eightgent" reads EIGHT_BOT_TOKEN / EIGHT_CHAT_ID, matching the
	// 8gi-governance webhook convention so a single secrets file can drive both
	// bridges without per-service variable mapping.
	const botName = (process.env.BOT_NAME || "").toLowerCase();
	const tokenVar = botName === "eightgent" ? "EIGHT_BOT_TOKEN" : "TELEGRAM_BOT_TOKEN";
	const chatVar = botName === "eightgent" ? "EIGHT_CHAT_ID" : "TELEGRAM_CHAT_ID";
	const token = process.env[tokenVar];
	const chatId = process.env[chatVar];

	if (!token || !chatId) {
		console.error(`[telegram-bridge] ${tokenVar} and ${chatVar} required`);
		process.exit(1);
	}
	console.log(`[telegram-bridge] BOT_NAME=${botName || "aijames"} (reading ${tokenVar})`);

	const authorizedChatIds = splitIds(process.env.TELEGRAM_AUTHORIZED_CHAT_IDS);
	const authorizedUserIds = splitIds(process.env.TELEGRAM_AUTHORIZED_USER_IDS);
	const operatorUserIds = splitIds(process.env.TELEGRAM_OPERATOR_USER_IDS);
	const chatsToWatch = authorizedChatIds.length > 0 ? authorizedChatIds : [chatId];
	if (authorizedUserIds.length === 0 && chatsToWatch.some((id) => id.startsWith("-"))) {
		console.warn(
			"[telegram-bridge] a group chat is allowlisted but TELEGRAM_AUTHORIZED_USER_IDS is empty: every sender in that group will be refused",
		);
	}
	const bridge = new TelegramDaemonBridge({
		telegramToken: token,
		chatId,
		daemonUrl: process.env.DAEMON_URL || "ws://localhost:18789",
		authToken: process.env.DAEMON_AUTH_TOKEN,
		devGroupId: process.env.TELEGRAM_DEV_GROUP_ID,
		authorizedChatIds: authorizedChatIds.length > 0 ? authorizedChatIds : undefined,
		authorizedUserIds: authorizedUserIds.length > 0 ? authorizedUserIds : undefined,
		operatorUserIds: operatorUserIds.length > 0 ? operatorUserIds : undefined,
	});

	bridge.start().catch((err) => {
		console.error("[telegram-bridge] fatal:", err);
		process.exit(1);
	});

	process.on("SIGTERM", () => bridge.stop());
	process.on("SIGINT", () => bridge.stop());
}
