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

import { DaemonClient, SessionStore, TelegramBridgeAdapter } from "../telegram-bot";
import { CB_PREFIX, parseCallbackData } from "../telegram-bot/keyboards";

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
		chat: { id: number };
		text?: string;
		voice?: { file_id: string; duration: number };
		audio?: { file_id: string; duration: number };
		web_app_data?: { data: string; button_text: string };
	};
	callback_query?: {
		id: string;
		from: { id: number };
		data?: string;
		message?: { message_id: number; chat: { id: number } };
	};
}

interface BridgeConfig {
	telegramToken: string;
	chatId: string;
	daemonUrl: string; // ws://localhost:18789 (same container)
	authToken?: string;
	devGroupId?: string; // Optional dev group for verbose logs
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
					parse_mode: parseMode,
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

/** Send a local WAV/OGG file as a Telegram voice message */
async function tgSendVoice(token: string, chatId: string, filePath: string, caption?: string): Promise<void> {
	const { readFileSync } = await import("node:fs");
	const { basename } = await import("node:path");
	const form = new FormData();
	form.append("chat_id", chatId);
	const blob = new Blob([readFileSync(filePath)], { type: "audio/wav" });
	form.append("voice", blob, basename(filePath));
	if (caption) form.append("caption", caption);
	await fetch(`${TELEGRAM_API}${token}/sendVoice`, { method: "POST", body: form }).catch(() => {});
}

/** Retrieve a GitHub issue, generate KittenTTS audio per section, send as voice messages */
async function handleRetrieveIssue(
	token: string,
	chatId: string,
	repo: string,
	issueNumber: number,
): Promise<void> {
	const { fetchGithubIssue, buildAudioChunks, cleanupChunks } = await import(
		"../tts/pipeline"
	);

	await tgSend(token, chatId, `Fetching issue #${issueNumber} from ${repo}...`);

	let issue: { title: string; body: string };
	try {
		issue = await fetchGithubIssue(repo, issueNumber);
	} catch (err: any) {
		await tgSend(token, chatId, `Could not fetch issue: ${err.message}`);
		return;
	}

	await tgSend(token, chatId, `*${issue.title}*\nGenerating audio...`);

	let chunks;
	try {
		chunks = await buildAudioChunks(issue.title, issue.body);
	} catch (err: any) {
		await tgSend(token, chatId, `Audio generation failed: ${err.message}`);
		return;
	}

	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i];
		await tgSendVoice(token, chatId, chunk.wavPath, `${chunk.officer} (${i + 1}/${chunks.length})`);
		// Small gap between messages so they arrive in order
		await new Promise((r) => setTimeout(r, 300));
	}

	cleanupChunks(chunks);
	await tgSend(token, chatId, `Done. ${chunks.length} audio messages sent. Reply by voice to continue.`);
}

/** Download a Telegram voice/audio file and transcribe it locally via whisper CLI */
async function transcribeVoice(token: string, fileId: string): Promise<string> {
	// 1. Get file path from Telegram
	const fileRes = await fetch(`${TELEGRAM_API}${token}/getFile`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ file_id: fileId }),
	});
	const fileData = await fileRes.json();
	if (!fileData.ok || !fileData.result?.file_path) {
		return "[could not download voice message]";
	}

	// 2. Download the audio file to a temp path
	const audioUrl = `https://api.telegram.org/file/bot${token}/${fileData.result.file_path}`;
	const audioRes = await fetch(audioUrl);
	const audioBuffer = await audioRes.arrayBuffer();

	const { writeFileSync, unlinkSync, mkdirSync, existsSync } = await import("node:fs");
	const { execSync } = await import("node:child_process");
	const tmpDir = "/tmp/8gent-voice";
	if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
	const tmpOgg = `${tmpDir}/voice-${Date.now()}.ogg`;
	const tmpOut = tmpDir;

	writeFileSync(tmpOgg, Buffer.from(audioBuffer));

	try {
		// 3a. Try local whisper CLI first (no network, no rate limits)
		const whisperBin = "/opt/homebrew/bin/whisper";
		if (existsSync(whisperBin)) {
			execSync(
				`${whisperBin} "${tmpOgg}" --model tiny --output_format txt --output_dir "${tmpOut}" --language en`,
				{ timeout: 60_000, stdio: "pipe" },
			);
			const txtPath = tmpOgg.replace(".ogg", ".txt");
			const { readFileSync } = await import("node:fs");
			if (existsSync(txtPath)) {
				const text = readFileSync(txtPath, "utf-8").trim();
				try { unlinkSync(txtPath); } catch {}
				try { unlinkSync(tmpOgg); } catch {}
				return text || "[empty transcription]";
			}
		}

		// 3b. Fallback: Groq API (may fail on restricted networks)
		const groqKey = process.env.GROQ_API_KEY;
		const openaiKey = process.env.OPENAI_API_KEY;
		const transcriptionKey = groqKey || openaiKey;
		if (transcriptionKey) {
			const transcriptionUrl = groqKey
				? "https://api.groq.com/openai/v1/audio/transcriptions"
				: "https://api.openai.com/v1/audio/transcriptions";
			const { readFileSync } = await import("node:fs");
			const formData = new FormData();
			const audioBlob = new Blob([readFileSync(tmpOgg)], { type: "audio/ogg" });
			formData.append("file", audioBlob, "voice.ogg");
			formData.append("model", groqKey ? "whisper-large-v3" : "whisper-1");
			const whisperRes = await fetch(transcriptionUrl, {
				method: "POST",
				headers: { Authorization: `Bearer ${transcriptionKey}` },
				body: formData,
			});
			if (whisperRes.ok) {
				const result = await whisperRes.json();
				try { unlinkSync(tmpOgg); } catch {}
				return result.text || "[empty transcription]";
			}
		}
	} catch (err) {
		console.error("[telegram-bridge] transcription failed:", err);
	} finally {
		try { unlinkSync(tmpOgg); } catch {}
	}

	return "[voice message received - transcription failed, please send as text]";
}

type ChatAction =
	| "typing"
	| "upload_document"
	| "record_voice"
	| "upload_voice"
	| "record_video"
	| "upload_video"
	| "upload_photo"
	| "find_location";

async function tgTyping(token: string, chatId: string, action: ChatAction = "typing"): Promise<void> {
	await fetch(`${TELEGRAM_API}${token}/sendChatAction`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chat_id: chatId, action }),
	}).catch(() => {});
}

async function tgReact(token: string, chatId: string, messageId: number, emoji: string): Promise<void> {
	await fetch(`${TELEGRAM_API}${token}/setMessageReaction`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			chat_id: chatId,
			message_id: messageId,
			reaction: [{ type: "emoji", emoji }],
			is_big: false,
		}),
	}).catch(() => {});
}

async function tgSendDocument(token: string, chatId: string, filePath: string, caption?: string): Promise<void> {
	const { readFileSync } = await import("node:fs");
	const { basename } = await import("node:path");
	const form = new FormData();
	form.append("chat_id", chatId);
	const blob = new Blob([readFileSync(filePath)]);
	form.append("document", blob, basename(filePath));
	if (caption) form.append("caption", caption);
	await fetch(`${TELEGRAM_API}${token}/sendDocument`, { method: "POST", body: form }).catch(() => {});
}

const APFEL_URL = process.env.APFEL_URL ?? "http://localhost:11435";

/**
 * Use Apple Foundation model as a fast intent router.
 * Falls back to regex heuristic if apfel is unavailable.
 */
/**
 * Message packet — the envelope Apple Foundation tags every incoming message with.
 * Treat it like a network packet header: intent, priority, topic, delegate, background job.
 */
export interface MessagePacket {
	/** Primary routing decision */
	intent: "chat" | "task";
	/** Which model handles the response */
	delegate: "apfel" | "qwen" | "auto";
	/** Rough topic for context-key selection */
	topic: string;
	/** Optional background job to fire alongside the main response */
	background: "update_github_issue" | "log_to_memory" | "none";
	/** Priority hint for the task queue */
	priority: "low" | "normal" | "high";
}

async function routeMessage(text: string): Promise<MessagePacket> {
	const t = text.trim().toLowerCase();

	// Slash commands are always high-priority tasks
	if (t.startsWith("/")) {
		return { intent: "task", delegate: "qwen", topic: "command", background: "none", priority: "high" };
	}

	// Hard structural signals — skip model call entirely
	const hardTaskSignals = [
		/[/\\~][\w./]{3,}/,
		/https?:\/\//,
		/#\d+/,
		/`[^`]+`/,
		/\.(ts|js|py|json|md|tsx|jsx|sh|css|html)\b/,
		/\b(repo|branch|pr|pull request|commit|diff|rebase)\b/,
		/\b(error|bug|broken|failing|crash|exception|traceback|stacktrace)\b/,
	];
	if (hardTaskSignals.some((p) => p.test(t))) {
		return { intent: "task", delegate: "qwen", topic: "code", background: "log_to_memory", priority: "high" };
	}

	// Apple Foundation tags the packet — on-device, ~200ms, no cost
	try {
		const res = await fetch(`${APFEL_URL}/v1/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "apple-foundationmodel",
				stream: false,
				max_tokens: 60,
				response_format: { type: "json_object" },
				messages: [
					{
						role: "system",
						content:
							"You are a message packet router. Tag every message with a JSON envelope.\n" +
							'Return: {"intent":"chat"|"task","delegate":"apfel"|"qwen","topic":"<one word>","background":"update_github_issue"|"log_to_memory"|"none","priority":"low"|"normal"|"high"}\n' +
							"Rules: chat=casual/social→delegate apfel. task=do something specific→delegate qwen.\n" +
							"background=update_github_issue when a task relates to tracked work. log_to_memory when new context/decisions mentioned.",
					},
					{ role: "user", content: text },
				],
			}),
			signal: AbortSignal.timeout(2000),
		});
		if (res.ok) {
			const data = await res.json() as { choices?: { message?: { content: string } }[] };
			const raw = data.choices?.[0]?.message?.content ?? "";
			const parsed = JSON.parse(raw) as Partial<MessagePacket>;
			if (parsed.intent) {
				return {
					intent: parsed.intent,
					delegate: parsed.delegate ?? (parsed.intent === "chat" ? "apfel" : "qwen"),
					topic: parsed.topic ?? "general",
					background: parsed.background ?? "none",
					priority: parsed.priority ?? "normal",
				};
			}
		}
	} catch {}

	// Regex fallback if apfel is down
	const words = t.split(/\s+/).filter(Boolean);
	const isTask = words.length > 15 ||
		/^(fix|create|build|add|update|generate|write|make|install|configure|debug|refactor|implement|deploy|setup|launch|ship)\b.{5,}/.test(t);
	return {
		intent: isTask ? "task" : "chat",
		delegate: isTask ? "qwen" : "apfel",
		topic: "general",
		background: "none",
		priority: "normal",
	};
}

const MINI_APP_URL = process.env.MINI_APP_URL || "https://8gi.org/internal";

function miniAppButton(label = "📱 Open Dashboard"): object {
	return { text: label, web_app: { url: MINI_APP_URL } };
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
	private pendingApprovals = new Map<string, { tool: string; input: unknown }>();
	private cosRouter: InstanceType<typeof import("./cos-router").CoSRouter> | null = null;
	private lastUserMessageId = 0;

	// Multi-step task runtime (issue #1906 / #1913).
	private multiStepEnabled: boolean = MULTI_STEP_ENABLED;
	private daemonClient: DaemonClient | null = null;
	private adapter: TelegramBridgeAdapter | null = null;
	private sessionStore: SessionStore | null = null;

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
					chatId: this.config.chatId,
					daemon: this.daemonClient,
					sessionStore: this.sessionStore,
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
					tgSend(this.config.telegramToken, this.config.chatId, payload.chunk);
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
				tgSend(this.config.telegramToken, this.config.chatId, `Error: ${payload.error}`);
				break;

			case "session:end":
				this.agentBusy = false;
				if (this._retryTimer) {
					clearTimeout(this._retryTimer);
					this._retryTimer = null;
				}
				if (this.lastUserMessageId) {
					tgReact(this.config.telegramToken, this.config.chatId, this.lastUserMessageId, "👍");
				}
				break;

			case "approval:required":
				// NemoClaw-style operator approval via Telegram
				this.sendApprovalRequest(payload);
				break;

			case "tool:start": {
				// Use a contextual chat action based on the tool being invoked
				const tool = (payload as any)?.tool as string | undefined;
				let action: ChatAction = "typing";
				if (tool === "Bash") action = "typing";
				else if (tool === "Write" || tool === "Edit") action = "upload_document";
				else if (tool === "WebFetch" || tool === "WebSearch") action = "typing";
				tgTyping(this.config.telegramToken, this.config.chatId, action);
				break;
			}
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
						if (update.message?.message_id) {
							this.lastUserMessageId = update.message.message_id;
						}
						if (update.callback_query) {
							await this.handleCallbackQuery(update.callback_query);
						} else if (update.message?.web_app_data) {
							// Mini App sending data back to the bot
							const { data: waData } = update.message.web_app_data;
							console.log(`[telegram-bridge] web_app_data: ${waData.slice(0, 100)}`);
							await this.handleWebAppData(waData, update.message.chat.id);
						} else if (update.message?.voice || update.message?.audio) {
							// Voice/audio message - transcribe then process
							const fileId = update.message.voice?.file_id || update.message.audio?.file_id;
							if (fileId && update.message.chat) {
								await tgTyping(this.config.telegramToken, this.config.chatId, "record_voice");
								const transcript = await transcribeVoice(this.config.telegramToken, fileId);
								console.log(`[telegram-bridge] voice transcription: "${transcript.slice(0, 100)}"`);
								if (!transcript.startsWith("[")) {
									await tgSend(
										this.config.telegramToken,
										this.config.chatId,
										`Heard: "${transcript}"`,
									);
									await this.handleTelegramMessage(transcript, update.message.chat.id);
								} else {
									await tgSend(this.config.telegramToken, this.config.chatId, transcript);
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

	private async handleWebAppData(data: string, chatId: number): Promise<void> {
		if (String(chatId) !== this.config.chatId) return;
		// Parse JSON payload if present, otherwise treat as raw text
		let text = data;
		try {
			const parsed = JSON.parse(data) as Record<string, unknown>;
			// Support { action, payload } envelope from the Mini App
			if (typeof parsed.action === "string") {
				text = parsed.payload ? `${parsed.action}: ${JSON.stringify(parsed.payload)}` : parsed.action;
			} else if (typeof parsed.text === "string") {
				text = parsed.text;
			}
		} catch {}
		await this.handleTelegramMessage(text, chatId);
	}

	private async handleTelegramMessage(text: string, chatId: number): Promise<void> {
		// Only respond to the configured chat
		if (String(chatId) !== this.config.chatId) return;

		// Route message through Apple Foundation packet tagger
		const packet = await routeMessage(text);
		const intent = packet.intent;

		// Show typing
		await tgTyping(this.config.telegramToken, this.config.chatId);

		// CEO commands via CoS router (delegate, plan, review, goals, kill)
		if (this.cosRouter) {
			const handled = await this.cosRouter.handleCommand(text, chatId);
			if (handled) return;
		}

		// "retrieve issue #N from org/repo" → KittenTTS audio pipeline
		const issueMatch = text.match(/retrieve\s+issue\s+#?(\d+)\s+from\s+([\w.\-/]+)/i);
		if (issueMatch) {
			const issueNumber = parseInt(issueMatch[1], 10);
			const repo = issueMatch[2];
			await tgTyping(this.config.telegramToken, this.config.chatId, "record_voice");
			await handleRetrieveIssue(this.config.telegramToken, this.config.chatId, repo, issueNumber);
			return;
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
					this.config.chatId,
					`*Recent Logs*\n\`\`\`\n${logs.slice(-3000)}\n\`\`\``,
				);
			} catch {
				await tgSend(this.config.telegramToken, this.config.chatId, "Could not read logs.");
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
				this.config.chatId,
				"Cleared busy state. Ready for new messages.",
			);
			return;
		}

		if (text === "/cancel") {
			if (this.adapter) {
				const cancelled = await this.adapter.cancelCurrent();
				await tgSend(
					this.config.telegramToken,
					this.config.chatId,
					cancelled ? "Task cancelled." : "Nothing to cancel.",
				);
			} else {
				this.agentBusy = false;
				await tgSend(this.config.telegramToken, this.config.chatId, "Reset (legacy mode).");
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
					this.config.chatId,
					`*Eight Status*\nSessions: ${health.sessions}\nUptime: ${Math.round(health.uptime)}s\nStatus: ${health.status}`,
				);
			} catch {
				await tgSend(
					this.config.telegramToken,
					this.config.chatId,
					"Could not reach daemon health endpoint.",
				);
			}
			return;
		}

		if (text === "/help") {
			await fetch(`${TELEGRAM_API}${this.config.telegramToken}/sendMessage`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					chat_id: this.config.chatId,
					text: "*Eight — Telegram OS*\n\nJust talk naturally — I'll figure out if you need a quick reply or a full task.\n\n*Commands*\n/status — Daemon health\n/cancel — Stop current task\n/unstick — Reset busy state\n/logs — Tail daemon logs\n/help — This message\n\n*Voice* — Send a voice message, I'll transcribe and act on it.\n\n*Issues* — \"retrieve issue #N from org/repo\" → audio briefing\n\nFull tool access: shell, git, files, web, GitHub.",
					parse_mode: "Markdown",
					reply_markup: {
						inline_keyboard: [[miniAppButton()]],
					},
				}),
			}).catch(() => {});
			return;
		}

		// Casual chat: fast direct path with streaming display
		if (intent === "chat") {
			await this.handleChat(text);
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
					this.config.chatId,
					`Adapter error: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			return;
		}

		// Legacy single-shot path (EIGHT_TG_LEGACY=1).
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			await tgSend(
				this.config.telegramToken,
				this.config.chatId,
				"Daemon not connected. Reconnecting...",
			);
			await this.connectDaemon().catch(() => {});
			return;
		}

		if (this.agentBusy) {
			await tgSend(
				this.config.telegramToken,
				this.config.chatId,
				"Still working on the previous request. I'll get to this next.",
			);
			return;
		}

		this.agentBusy = true;
		this.retryPrompt(text, 1);
	}

	/**
	 * Direct Ollama streaming call for casual chat.
	 * Sends a gap-filler audio nudge only if Ollama takes > 3s to respond.
	 * Text streams into an edited placeholder message.
	 */
	private async handleChat(text: string): Promise<void> {
		// Apple Foundation handles chat — on-device, near-instant, frees qwen for tasks
		const chatUrl = `${APFEL_URL}/v1/chat/completions`;
		const chatModel = "apple-foundationmodel";

		// Schedule a gap-filler audio nudge - only fires if model is slow
		let nudgeFired = false;
		const nudgeTimer = setTimeout(async () => {
			nudgeFired = true;
			const { classifyBucket, pickClip } = await import("../tts/audio-lib");
			const clip = pickClip(classifyBucket(text));
			if (clip) tgSendVoice(this.config.telegramToken, this.config.chatId, clip).catch(() => {});
		}, 3000);

		// Send text placeholder so user sees something right away
		let msgId: number | null = null;
		try {
			const ph = await fetch(`${TELEGRAM_API}${this.config.telegramToken}/sendMessage`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ chat_id: this.config.chatId, text: "▍" }),
			});
			const phData = await ph.json() as { ok: boolean; result?: { message_id: number } };
			if (phData.ok) msgId = phData.result?.message_id ?? null;
		} catch {}

		try {
			const res = await fetch(chatUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: chatModel,
					stream: true,
					max_tokens: 150,
					messages: [
						{
							role: "system",
							content:
								"You are 8gent, 8GI Foundation's personal AI running locally on his Mac. " +
								"Respond naturally in 1-3 sentences. No markdown headers or lists. Just talk.",
						},
						{ role: "user", content: text },
					],
				}),
			});

			if (!res.ok || !res.body) throw new Error(`apfel ${res.status}`);

			let accumulated = "";
			let lastEdit = 0;
			const reader = res.body.getReader();
			const decoder = new TextDecoder();

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				// OpenAI SSE format: "data: {...}" lines
				const lines = decoder.decode(value).split("\n").filter(Boolean);
				for (const line of lines) {
					const raw = line.startsWith("data: ") ? line.slice(6) : line;
					if (raw === "[DONE]") break;
					try {
						const chunk = JSON.parse(raw) as { choices?: { delta?: { content?: string } }[] };
						const token = chunk.choices?.[0]?.delta?.content;
						if (token) accumulated += token;
					} catch {}
				}
				// Edit the placeholder every ~400ms to show streaming tokens
				const now = Date.now();
				if (msgId && accumulated && now - lastEdit > 400) {
					lastEdit = now;
					fetch(`${TELEGRAM_API}${this.config.telegramToken}/editMessageText`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							chat_id: this.config.chatId,
							message_id: msgId,
							text: accumulated + " ▍",
						}),
					}).catch(() => {});
				}
			}

			// Cancel nudge if model responded fast enough
			clearTimeout(nudgeTimer);

			// Final edit - clean cursor
			const reply = accumulated.trim() || "Hey! What's up?";
			if (msgId) {
				await fetch(`${TELEGRAM_API}${this.config.telegramToken}/editMessageText`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ chat_id: this.config.chatId, message_id: msgId, text: reply }),
				}).catch(() => {});
			} else {
				await tgSend(this.config.telegramToken, this.config.chatId, reply);
			}

			if (this.lastUserMessageId) {
				tgReact(this.config.telegramToken, this.config.chatId, this.lastUserMessageId, "👍");
			}
		} catch {
			clearTimeout(nudgeTimer);
			const fallback = "Hey! What's on your mind?";
			if (msgId) {
				await fetch(`${TELEGRAM_API}${this.config.telegramToken}/editMessageText`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ chat_id: this.config.chatId, message_id: msgId, text: fallback }),
				}).catch(() => {});
			} else {
				await tgSend(this.config.telegramToken, this.config.chatId, fallback);
			}
		}
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
				this.config.chatId,
				"Taking a bit longer than expected. Trying a simpler approach...",
			);
		} else if (attempt === 3) {
			prompt = `Respond in one short paragraph. Do NOT use any tools. Just answer from what you know. Question: ${originalText}`;
			tgSend(
				this.config.telegramToken,
				this.config.chatId,
				"Still working on it. Trying without tools this time...",
			);
		} else if (attempt >= 4) {
			// Final fallback - just acknowledge
			this.agentBusy = false;
			tgSend(
				this.config.telegramToken,
				this.config.chatId,
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
		this.pendingApprovals.set(requestId, { tool, input });

		const inputPreview =
			typeof input === "string" ? input.slice(0, 200) : JSON.stringify(input).slice(0, 200);

		try {
			await fetch(`${TELEGRAM_API}${this.config.telegramToken}/sendMessage`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					chat_id: this.config.chatId,
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

	private async handleCallbackQuery(
		query: NonNullable<TelegramUpdate["callback_query"]>,
	): Promise<void> {
		const data = query.data || "";
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
				await tgSend(
					this.config.telegramToken,
					this.config.chatId,
					"Send your next message to continue.",
				);
				return;
			}
		}

		const action = prefix;
		if (!requestId || !this.pendingApprovals.has(requestId)) {
			return;
		}

		const approval = this.pendingApprovals.get(requestId)!;
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

// ── Entry point ──────────────────────────────────────────────────────

if (import.meta.main) {
	const token = process.env.TELEGRAM_BOT_TOKEN;
	const chatId = process.env.TELEGRAM_CHAT_ID;

	if (!token || !chatId) {
		console.error("[telegram-bridge] TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID required");
		process.exit(1);
	}

	const bridge = new TelegramDaemonBridge({
		telegramToken: token,
		chatId,
		daemonUrl: process.env.DAEMON_URL || "ws://localhost:18789",
		authToken: process.env.DAEMON_AUTH_TOKEN,
		devGroupId: process.env.TELEGRAM_DEV_GROUP_ID,
	});

	bridge.start().catch((err) => {
		console.error("[telegram-bridge] fatal:", err);
		process.exit(1);
	});

	process.on("SIGTERM", () => bridge.stop());
	process.on("SIGINT", () => bridge.stop());
}
