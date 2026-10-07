/**
 * Telegram Bridge - Connects Telegram to the daemon's WebSocket gateway.
 *
 * Polls Telegram for messages, routes them to the daemon as prompts,
 * streams events back as Telegram messages. Runs inside the Vessel container
 * alongside the daemon process.
 *
 * - Natural language prompts (routed to the agent through its normal gates)
 * - /status for daemon health
 * - Operator-only commands (see OPERATOR_COMMANDS) and a private-chat-only
 *   gate on /run and /deploy (see PRIVILEGED_COMMANDS). The bridge has no
 *   handler of its own for either: they are refused outside an operator DM
 *   and otherwise fall through as ordinary prompts.
 * - Startup notification: "I'm online. What do we work on next?"
 */

import { resolveHome } from "../core/home";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DaemonClient, SessionStore, TelegramBridgeAdapter } from "../telegram-bot";
import {
	BOARD_ROSTER,
	VOICE_BY_OFFICER,
	askOfficerViaClaude,
	askVerdictViaClaude,
	runBoardroom,
} from "../telegram-bot/boardroom";
import { CB_PREFIX, parseCallbackData } from "../telegram-bot/keyboards";
import { approvalTtlMs } from "./channel-approvals";
import { NO_LINK_PREVIEW } from "./notifications";
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
export const OBSERVED_LOG = join(resolveHome(), ".8gent", "telegram-observed.jsonl");

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
			mkdirSync(dirname(OBSERVED_LOG), { recursive: true, mode: 0o700 });
		}

		// Private by construction: the log holds other people's words.
		if (!existsSync(OBSERVED_LOG)) writeFileSync(OBSERVED_LOG, "", { mode: 0o600 });
		chmodSync(OBSERVED_LOG, 0o600);
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

export interface MsgEntity {
	type: string;
	offset: number;
	length: number;
}

type BridgeMessage = NonNullable<TelegramUpdate["message"]>;

interface TelegramUpdate {
	update_id: number;
	message?: {
		message_id: number;
		from: { id: number; first_name: string; username?: string };
		chat: { id: number; type?: string };
		reply_to_message?: { from?: { id?: number } };
		entities?: MsgEntity[];
		forward_origin?: unknown;
		via_bot?: unknown;
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

export async function tgSend(
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
					...NO_LINK_PREVIEW,
				}),
			});
		} catch {
			// Retry without parse mode if markdown fails
			await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ chat_id: chatId, text: chunk, ...NO_LINK_PREVIEW }),
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
		console.error("[telegram-bridge] transcription failed:", scrubErr(err, token));
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

/**
 * Commands that run code or ship it. Direct shell and deploys are the one
 * power in this bridge that a group must never hold, whoever is in it: the
 * chat id of a group names a crowd, and a message in a group is data, not an
 * instruction to execute. Allowed only for an operator, in a private chat.
 */
export const PRIVILEGED_COMMANDS = ["/run", "/deploy"] as const;

/**
 * Commands that dispatch, kill or read the machine's logs. Operator only, but
 * unlike PRIVILEGED_COMMANDS they may be used in the operator's group, since
 * they act through the normal agent gates rather than as a raw shell.
 */
export const OPERATOR_COMMANDS = [
	"/delegate",
	"/kill",
	"/logs",
	"/goals",
	"/voice",
	"/boardroom",
	"/cancel",
	"/unstick",
	"/plan",
	"/review",
] as const;

/** Commands anyone in the allowlist may use. Everything else starting with "/" is refused. */
export const OPEN_COMMANDS = ["/status", "/help"] as const;

/**
 * Strip zero-width and other format characters (ZWSP, ZWJ, BOM, bidi marks...)
 * so `/boardroom\u200Bx` cannot slip past a parser that sees two words while a
 * router sees one. Run before any command parsing.
 */
export function cleanText(text: string): string {
	return text.replace(/[\p{Cf}\u200B-\u200D\u2060\uFEFF]/gu, "").trim();
}

/** Entity types inside which an @mention is not an address. */
const NON_MENTION_CONTAINERS = new Set(["code", "pre", "url", "text_link"]);

export interface SenderCtx {
	chatType?: string;
	fromId?: number;
	/** The message replies to one of this bot's own messages (by bot id). */
	replyToBot?: boolean;
	/** Entities of the ORIGINAL text; offsets are UTF-16 code units. */
	entities?: MsgEntity[];
	/** Forwarded or sent via an inline bot: never an address. */
	forwarded?: boolean;
}

/**
 * Group addressing. In a group the bot acts only when spoken to:
 *   - a `mention` entity, leading the message, whose text equals @<username>
 *     (case-insensitive), sliced from the ORIGINAL text by its UTF-16 offsets
 *     and not inside a code, pre, url or text_link entity;
 *   - a reply to one of the bot's own messages (id match, decided by the caller);
 *   - a /command@<username> naming this bot;
 *   - a bare /command, only from an operator.
 * Everything else, the operator's own chat with people included, is ignored.
 * Forwarded and via-bot messages are never addressed. Private chats always are.
 * Fails closed: with no known username nothing mentions the bot.
 * Addressing never widens authority: the tier gate still runs afterwards.
 * Returns the cleaned text with the leading @mention removed.
 */
export function groupAddressing(
	rawText: string,
	input: SenderCtx,
	bot: { username?: string | null },
	config: SenderConfig,
): { addressed: boolean; text: string } {
	const type = input.chatType ?? "private";
	if (type === "private") return { addressed: true, text: cleanText(rawText) };
	if (input.forwarded) return { addressed: false, text: cleanText(rawText) };
	const name = bot.username?.replace(/^@/, "").toLowerCase();
	const entities = input.entities ?? [];
	if (name) {
		for (const e of entities) {
			if (e.type !== "mention") continue;
			if (cleanText(rawText.slice(0, e.offset)) !== "") continue; // must lead
			if (rawText.slice(e.offset, e.offset + e.length).toLowerCase() !== `@${name}`) continue;
			const inside = entities.some(
				(c) =>
					NON_MENTION_CONTAINERS.has(c.type) &&
					e.offset >= c.offset &&
					e.offset < c.offset + c.length,
			);
			if (inside) continue;
			const rest = rawText.slice(0, e.offset) + rawText.slice(e.offset + e.length);
			return { addressed: true, text: cleanText(rest).replace(/^[:,]\s*/, "") };
		}
	}
	const text = cleanText(rawText);
	if (input.replyToBot) return { addressed: true, text };
	if (text.startsWith("/")) {
		const cmd = commandOf(text, name);
		if (!cmd) return { addressed: false, text }; // another bot's command, or unparseable
		if (/^\/[A-Za-z0-9_]+@/.test(text)) return { addressed: true, text }; // names us
		const id = typeof input.fromId === "number" ? String(input.fromId) : null;
		return { addressed: !!id && operatorsOf(config).includes(id), text };
	}
	return { addressed: false, text };
}

/** Redact bot tokens from anything about to be logged: fetch errors embed the URL. */
export function scrubErr(err: unknown, token?: string): string {
	let m = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
	m = m.replace(/\/bot[^/\s"']+/g, "/bot<redacted>");
	if (token) m = m.split(token).join("<redacted>");
	return m;
}

export const COS_COMMANDS: string[] = [
	"/delegate",
	"/plan",
	"/review",
	"/goals",
	"/kill",
	"/status",
];

export type SenderTier = "full" | "prompt" | "observe";

interface SenderConfig {
	authorizedUserIds?: string[];
	operatorUserIds?: string[];
	/** This bot's own username from getMe; a /cmd@suffix must match it. */
	botUsername?: string | null;
}

/** The operators: explicit list, else the first authorised user. Never empty-means-all. */
function operatorsOf(config: SenderConfig): string[] {
	if (config.operatorUserIds && config.operatorUserIds.length > 0) return config.operatorUserIds;
	return config.authorizedUserIds?.slice(0, 1) ?? [];
}

/**
 * Three tiers by Telegram user id.
 *   full    - an operator: prompts and commands.
 *   prompt  - an authorised user who is not an operator: prompts only.
 *   observe - everyone else (and every group sender when no allowlist is set):
 *             recorded to OBSERVED_LOG, never answered.
 */
export function senderTier(
	input: { chatType?: string; fromId?: number },
	config: SenderConfig,
): SenderTier {
	if (!isSenderAuthorized(input, { authorizedUserIds: config.authorizedUserIds })) return "observe";
	const id = typeof input.fromId === "number" ? String(input.fromId) : null;
	if (id && operatorsOf(config).includes(id)) return "full";
	// Private chat with no allowlist is the single-operator case, as before.
	if (!config.authorizedUserIds || config.authorizedUserIds.length === 0) return "full";
	return "prompt";
}

/** `/Run@our_bot args` -> `/run`; null when not a slash command or the suffix names another bot. */
export function commandOf(text: string, botUsername?: string | null): string | null {
	const m = /^\s*(\/[A-Za-z0-9_]+)(?:@(\w+))?(?:\s|$)/.exec(text);
	if (!m) return null;
	// A suffix names a bot. It must be this one: /cmd@otherbot is not ours.
	if (m[2] && m[2].toLowerCase() !== botUsername?.replace(/^@/, "").toLowerCase()) return null;
	return m[1].toLowerCase();
}

/**
 * Gate for a message that has already passed the chat and sender checks.
 * Pure and fail-closed. Parses once, with commandOf, on cleaned text:
 *   - not a slash message: a prompt. Only a full-tier sender may prompt;
 *     everyone else shares no session with the operator (see below).
 *   - slash text that does not parse, or names an unknown command: refused.
 *   - /run and /deploy: operator, private chat only.
 *   - OPERATOR_COMMANDS: full tier only.
 *   - OPEN_COMMANDS: any authorised sender.
 *
 * Why prompts are full-tier only: the bridge's daemon session runs headless on
 * the `telegram` channel with write_full and admin, and run_command is
 * auto-approved there. A second person's prompt would land in the operator's
 * own session with the operator's powers. Until non-operator prompts get a
 * separate deny-by-default session, they are refused.
 */
export function isCommandAllowed(
	rawText: string,
	input: { chatType?: string; fromId?: number } | undefined,
	config: SenderConfig,
): boolean {
	const text = cleanText(rawText);
	const full = input !== undefined && senderTier(input, config) === "full";
	if (!text.startsWith("/")) return full;
	const cmd = commandOf(text, config.botUsername);
	if (!cmd) return false;
	if ((OPEN_COMMANDS as readonly string[]).includes(cmd)) return true;
	if ((PRIVILEGED_COMMANDS as readonly string[]).includes(cmd)) {
		const id = typeof input?.fromId === "number" ? String(input.fromId) : null;
		return !!id && operatorsOf(config).includes(id) && input?.chatType === "private";
	}
	if ((OPERATOR_COMMANDS as readonly string[]).includes(cmd)) return full;
	return false;
}

/**
 * The bridge's own agent pool defaults to the local provider. A cloud runtime
 * is used only when DEFAULT_RUNTIME names one; a stray DEFAULT_MODEL alone
 * never moves traffic off the machine.
 */
export const LOCAL_DEFAULT_RUNTIME = "ollama";
export const LOCAL_DEFAULT_MODEL = "eight-1.0-q3:14b";
export function resolveBridgeModel(env: Record<string, string | undefined>): {
	runtime: string;
	model: string;
} {
	const runtime = env.DEFAULT_RUNTIME?.trim() || LOCAL_DEFAULT_RUNTIME;
	const local = runtime === "ollama" || runtime === "8gent" || runtime === "lmstudio";
	const model = env.DEFAULT_MODEL?.trim() || (local ? LOCAL_DEFAULT_MODEL : "auto:free");
	return { runtime, model };
}

/**
 * Two pollers on one bot token share one getUpdates lease and silently drop
 * each other's messages. Refuse to start if this bridge's token hashes to the
 * AI James bot's. The reference is a SHA-256 hex digest, from
 * AI_JAMES_BOT_TOKEN_SHA256 or the file named by AI_JAMES_BOT_TOKEN_SHA256_FILE
 * (default ~/.8gent/ai-james-bot-token.sha256), so no token is ever stored in
 * the check and none is ever printed. Returns false when no reference exists.
 */
export function assertNotAiJamesToken(
	token: string,
	env: Record<string, string | undefined> = process.env,
	readRef: (path: string) => string | null = (p) => {
		try {
			return readFileSync(p, "utf8");
		} catch {
			return null;
		}
	},
	chatIds: string[] = [],
): boolean {
	const file =
		env.AI_JAMES_BOT_TOKEN_SHA256_FILE || `${resolveHome()}/.8gent/ai-james-bot-token.sha256`;
	const ref = (env.AI_JAMES_BOT_TOKEN_SHA256 || readRef(file) || "").trim().toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(ref)) {
		// A check that silently skips is not a check. Group mode (any negative
		// chat id) refuses to start without a reference; DM-only warns.
		if (chatIds.some((id) => id.trim().startsWith("-"))) {
			throw new Error(
				"refusing to start in group mode: AI_JAMES_BOT_TOKEN_SHA256 is not set (or AI_JAMES_BOT_TOKEN_SHA256_FILE is unreadable), so the shared-token check cannot run. Set it to the SHA-256 hex digest of the AI James bot token.",
			);
		}
		console.warn(
			"[telegram-bridge] AI_JAMES_BOT_TOKEN_SHA256 is not set: shared-token check skipped (DM-only mode)",
		);
		return false;
	}
	const mine = createHash("sha256").update(token.trim()).digest("hex");
	if (mine === ref) {
		throw new Error(
			"refusing to start: this bot token is the AI James bot token (shared getUpdates lease). Use the 8gent bot's own token.",
		);
	}
	return true;
}

// Import CoS router lazily to avoid circular deps
const CoSRouterClass: typeof import("./cos-router").CoSRouter | null = null;

interface PendingApproval {
	tool: string;
	input: unknown;
	chatId: string;
	sessionId: string;
	expiresAt: number;
	messageId?: number;
	/** The socket that owns the session: the answer must go back on it. */
	via: "ws" | "adapter";
}

const NOT_LIVE =
	"That request is no longer live (expired, replaced or already answered). Nothing ran.";

class TelegramDaemonBridge {
	private config: BridgeConfig;
	private ws: WebSocket | null = null;
	private sessionId: string | null = null;
	private lastUpdateId = 0;
	private polling = false;
	private agentReady = false;
	private agentBusy = false;
	/** Live approval cards by daemon request id (#3621). The daemon re-checks every answer. */
	private pendingApprovals = new Map<string, PendingApproval>();
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

	/** Set from getMe at startup; group addressing cannot match without it. */
	private botUsername: string | null = null;
	private botId: number | null = null;
	/** One DM refusal per sender per hour. Groups get none. */
	private refusedDms = new Map<number, number>();

	async start(): Promise<void> {
		console.log("[telegram-bridge] starting...");
		await this.assertNotAiJamesBot();

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
				this.watchAdapterApprovals(this.daemonClient);
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
			const { sessionApiKey } = await import("../eight/failover-provider-config");
			const { runtime: cosRuntimeName, model: cosModel } = resolveBridgeModel(process.env);
			const cosRuntime = cosRuntimeName as any;
			const cosPool = new AgentPool({
				model: cosModel,
				runtime: cosRuntime,
				workingDirectory: process.env.HOME ? `${process.env.HOME}/.8gent/workspace` : "/app",
				// Only the runtime's own key (#3261).
				apiKey: sessionApiKey(cosRuntime),
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

	/**
	 * Replace the bridge's daemon session: destroy the old agent, then create a
	 * new one. Telegram sessions are never evicted, so a create without the
	 * destroy leaks an agent until the daemon restarts (#3538).
	 */
	private freshSession(): void {
		const open = this.ws?.readyState === WebSocket.OPEN;
		if (open && this.sessionId) {
			this.ws?.send(JSON.stringify({ type: "session:destroy", sessionId: this.sessionId }));
		}
		// Cleared even when offline, so the next connect creates rather than resumes.
		this.sessionId = null;
		if (open) this.ws?.send(JSON.stringify({ type: "session:create", channel: "telegram" }));
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

				// Resume the session we already own on reconnect; a fresh create
				// would leak a never-evicted telegram agent (#3538).
				this.ws?.send(
					JSON.stringify(
						this.sessionId
							? { type: "session:resume", sessionId: this.sessionId, channel: "telegram" }
							: { type: "session:create", channel: "telegram" },
					),
				);
			};

			this.ws.onmessage = (event: MessageEvent) => {
				const msg = JSON.parse(
					typeof event.data === "string"
						? event.data
						: new TextDecoder().decode(event.data as ArrayBuffer),
				);
				this.handleDaemonMessage(msg);

				// Resolve on session creation or resume
				if (msg.type === "session:created" || msg.type === "session:resumed") {
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
		if (msg.type === "approval:resolved" && msg.ok === false) {
			tgSend(this.config.telegramToken, this.replyChat(), NOT_LIVE);
			return;
		}
		if (msg.type !== "event") return;

		const { event, payload } = msg;

		// Drop events addressed to a session this bridge no longer owns. Destroying
		// the old session in freshSession() echoes its session:end back on this
		// socket after sessionId was cleared; acting on it would mark the bridge
		// idle and cancel the retry timer armed for the replacement session.
		if (payload?.sessionId && payload.sessionId !== this.sessionId) return;

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
				this.sendApprovalRequest(payload, "ws");
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
							this.observeSender(update);
							continue;
						}
						if (update.callback_query) {
							await this.handleCallbackQuery(update.callback_query);
						} else if (update.message?.voice || update.message?.audio) {
							// Voice/audio message. Order: sender (above), addressing, tier,
							// and only then download, transcription and origin chat.
							const fileId = update.message.voice?.file_id || update.message.audio?.file_id;
							if (fileId && update.message.chat) {
								if (!(await this.admitVoice(update.message))) continue;
								await tgTyping(this.config.telegramToken, this.replyChat());
								const transcript = await transcribeVoice(this.config.telegramToken, fileId);
								console.log(`[telegram-bridge] voice transcription: "${transcript.slice(0, 100)}"`);
								if (!transcript.startsWith("[")) {
									await tgSend(
										this.config.telegramToken,
										this.replyChat(),
										`Heard: "${transcript}"`,
									);
									await this.dispatchTranscript(transcript, update.message);
								} else {
									await tgSend(this.config.telegramToken, this.replyChat(), transcript);
								}
							}
						} else if (update.message?.text) {
							await this.handleTelegramMessage(
								update.message.text,
								update.message.chat.id,
								this.senderCtx(update.message),
							);
						}
					}
				}
			} catch (err) {
				// Timeout or network error - just retry
				if (String(err).includes("abort")) continue;
				console.error("[telegram-bridge] poll error:", scrubErr(err, this.config.telegramToken));
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
		return this.originChatId ?? this.config.chatId;
	}

	/** A voice transcript is group text like any other: same sender context, same gate. */
	private async dispatchTranscript(transcript: string, message: BridgeMessage): Promise<void> {
		await this.handleTelegramMessage(
			transcript,
			message.chat.id,
			this.senderCtx({ ...message, entities: undefined }),
		);
	}

	/**
	 * Admission for a voice note, before anything is downloaded or transcribed:
	 * addressing, then tier. Sets the origin chat only once both pass.
	 */
	async admitVoice(message: BridgeMessage): Promise<boolean> {
		const ctx = this.senderCtx(message);
		const cfg = this.gateConfig();
		if (!groupAddressing("", ctx, { username: this.botUsername }, cfg).addressed) return false;
		if (senderTier(ctx, cfg) !== "full") {
			await this.refuseDm(ctx, message.chat.id);
			return false;
		}
		this.originChatId = String(message.chat.id);
		return true;
	}

	/** Gate config: the allowlists plus our own username for /cmd@suffix checks. */
	private gateConfig(): SenderConfig {
		return { ...this.config, botUsername: this.botUsername };
	}

	/** Sender context from a raw message. Reply counts only on the bot's own id. */
	private senderCtx(message: BridgeMessage): SenderCtx {
		return {
			chatType: message.chat.type,
			fromId: message.from?.id,
			replyToBot: this.botId !== null && message.reply_to_message?.from?.id === this.botId,
			entities: message.entities,
			forwarded: !!(message.forward_origin || message.via_bot),
		};
	}

	/**
	 * One refusal per sender per hour, DM only, never echoing what was said.
	 * Keyed by user id and bounded; a failed send stays silent.
	 */
	private async refuseDm(sender: SenderCtx | undefined, chatId: number): Promise<void> {
		if (sender?.chatType !== "private" || typeof sender.fromId !== "number") return;
		const now = Date.now();
		const last = this.refusedDms.get(sender.fromId) ?? 0;
		if (now - last < 60 * 60 * 1000) return;
		this.refusedDms.delete(sender.fromId);
		this.refusedDms.set(sender.fromId, now);
		while (this.refusedDms.size > 256) {
			const oldest = this.refusedDms.keys().next().value;
			if (oldest === undefined) break;
			this.refusedDms.delete(oldest);
		}
		await tgSend(
			this.config.telegramToken,
			String(chatId),
			"Operator only for now. Ask James for access.",
			"",
		).catch(() => {});
	}

	/**
	 * Second, independent same-token check: ask Telegram who this token is.
	 * Refuses on username `aijamesosbot`. If Telegram cannot be reached, group
	 * mode refuses (a check that skips is not a check); DM-only mode warns.
	 */
	private async assertNotAiJamesBot(): Promise<void> {
		const group = (this.config.authorizedChatIds ?? [this.config.chatId]).some((id) =>
			id.startsWith("-"),
		);
		try {
			const res = await fetch(`${TELEGRAM_API}${this.config.telegramToken.trim()}/getMe`, {
				signal: AbortSignal.timeout(10000),
			});
			const me = (await res.json()) as {
				ok?: boolean;
				result?: { username?: string; id?: number };
			};
			this.botUsername = me.result?.username ?? null;
			this.botId = me.result?.id ?? null;
			const name = me.result?.username?.toLowerCase();
			if (me.ok && name === "aijamesosbot") {
				throw new Error(
					"refusing to start: getMe says this token belongs to @aijamesosbot (shared getUpdates lease).",
				);
			}
			if (!me.ok) throw new Error("getMe not ok");
		} catch (err) {
			if (String(err).includes("refusing to start")) throw err;
			if (group) {
				throw new Error(
					"refusing to start in group mode: getMe could not verify the bot identity.",
				);
			}
			console.warn(
				"[telegram-bridge] getMe could not verify bot identity (DM-only mode, continuing)",
			);
		}
	}

	private isAuthorizedSender(chatType: string | undefined, fromId: number | undefined): boolean {
		return isSenderAuthorized(
			{ chatType, fromId },
			{ authorizedUserIds: this.config.authorizedUserIds },
		);
	}

	/**
	 * A sender outside the allowlist is observed, never answered: recorded to
	 * OBSERVED_LOG, no reply, no dispatch. Replying would let a group use the
	 * bot as an echo and tell strangers the bot is listening.
	 */
	private observeSender(update: TelegramUpdate): void {
		observeUnauthorized(update);
		console.warn(
			`[telegram-bridge] observed and dropped message from unauthorized sender ${update.message?.from?.id ?? "unknown"} in chat ${update.message?.chat?.id}`,
		);
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

	private async handleTelegramMessage(
		text: string,
		chatId: number,
		sender?: SenderCtx,
	): Promise<void> {
		// Only respond to authorized chats. In local mode this is the
		// hard boundary that prevents a leaked token from driving the
		// daemon from a chat that isn't James's.
		if (!this.isAuthorizedChat(chatId)) {
			console.warn(`[telegram-bridge] rejected message from unauthorized chat ${chatId}`);
			return;
		}

		// Order: sender (poll loop), addressing, tier. Only after all three:
		// transcription, origin chat, typing, routing.
		const gate = this.gateConfig();
		if (sender) {
			const addr = groupAddressing(text, sender, { username: this.botUsername }, gate);
			if (!addr.addressed) return;
			text = addr.text;
		}

		// Group text is data. Parse once: the gate and every router below work
		// from the same cleaned text and the same commandOf() result.
		if (!isCommandAllowed(text, sender, gate)) {
			console.warn(
				`[telegram-bridge] refused ${commandOf(cleanText(text), this.botUsername) ?? "prompt"} from ${sender?.fromId ?? "unknown"} in ${sender?.chatType ?? "unknown"} chat`,
			);
			// Silent in groups. In a DM, one reply per sender per hour.
			await this.refuseDm(sender, chatId);
			return;
		}
		text = cleanText(text);
		const cmd = commandOf(text, this.botUsername);
		const fullTier = !!sender && senderTier(sender, gate) === "full";

		// An authorised non-operator (prompt tier) may only reach /status and
		// /help. They are answered straight to the chat they came from and never
		// touch originChatId, or they could redirect the operator's in-flight turn.
		if (sender && !fullTier) {
			let reply = "Operator only for now. Ask James for access.";
			if (cmd === "/status") {
				try {
					const res = await fetch(
						`${this.config.daemonUrl
							.replace("ws", "http")
							.replace("wss", "https")
							.replace(/:\d+/, ":18789")}/health`,
					);
					const health = await res.json();
					reply = `Status: ${health.status === "ok" ? "up" : "down"}`;
				} catch {
					reply = "Could not reach daemon health endpoint.";
				}
			} else if (cmd === "/help") {
				reply = "/status - up or down\n/help - this message";
			}
			await tgSend(this.config.telegramToken, String(chatId), reply, "").catch(() => {});
			return;
		}

		// From here until the daemon's terminal event, this turn's output
		// belongs to this chat. Set before the first typing indicator so even
		// that lands in the right room.
		this.originChatId = String(chatId);

		// Show typing
		await tgTyping(this.config.telegramToken, this.replyChat());

		// CEO commands via CoS router (delegate, plan, review, goals, kill)
		if (this.cosRouter && cmd && COS_COMMANDS.includes(cmd) && (cmd !== "/status" || fullTier)) {
			const handled = await this.cosRouter.handleCommand(text, chatId);
			if (handled) return;
		}

		// Handle built-in commands
		if (cmd === "/logs") {
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

		if (cmd === "/unstick") {
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

		if (cmd === "/cancel") {
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

		if (cmd === "/status") {
			try {
				const res = await fetch(
					`${this.config.daemonUrl
						.replace("ws", "http")
						.replace("wss", "https")
						.replace(/:\d+/, ":18789")}/health`,
				);
				const health = await res.json();
				if (!fullTier) {
					await tgSend(
						this.config.telegramToken,
						this.replyChat(),
						`Status: ${health.status === "ok" ? "up" : "down"}`,
					);
					return;
				}
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

		if (cmd === "/voice") {
			await this.handleVoiceCommand(
				text
					.replace(/^\/voice(@\w+)?/i, "")
					.trim()
					.toLowerCase(),
			);
			return;
		}

		if (cmd === "/boardroom") {
			await this.handleBoardroom(text.replace(/^\/boardroom(@\w+)?/i, "").trim());
			return;
		}

		if (cmd === "/help") {
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
				console.error(
					"[telegram-bridge] adapter error, falling back to legacy:",
					scrubErr(err, this.config.telegramToken),
				);
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
			console.error(
				"[telegram-bridge] boardroom failed:",
				scrubErr(err, this.config.telegramToken),
			);
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
					...NO_LINK_PREVIEW,
				}),
			});
			const data = await res.json();
			return data?.result?.message_id ?? null;
		} catch (err) {
			console.error(
				"[telegram-bridge] sendTracked failed:",
				scrubErr(err, this.config.telegramToken),
			);
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
				...NO_LINK_PREVIEW,
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
				this.freshSession();
				// Retry with next strategy
				this.retryPrompt(originalText, attempt + 1);
			}
		}, timeout);

		// Clear the timer if we get a response (handled by agentBusy being set to false)
		this._retryTimer = timer;
	}

	private _retryTimer: ReturnType<typeof setTimeout> | null = null;

	private async sendApprovalRequest(payload: any, via: PendingApproval["via"]): Promise<void> {
		const { requestId, tool, input, sessionId } = payload;
		const now = Date.now();
		// One live card per session: the daemon has already denied the older
		// prompt, so take its buttons away. Expired cards are dropped too.
		for (const [id, p] of this.pendingApprovals) {
			if (p.sessionId !== sessionId && p.expiresAt > now) continue;
			this.pendingApprovals.delete(id);
			if (p.sessionId === sessionId) await this.closeApprovalCard(p, "Replaced by a newer request");
		}
		// Expire a little before the daemon does, so a press the card accepts is one the daemon still holds.
		const ttl = approvalTtlMs();
		const entry: PendingApproval = {
			tool,
			input,
			chatId: this.replyChat(),
			sessionId,
			expiresAt: now + ttl - Math.min(5000, ttl / 10),
			via,
		};
		this.pendingApprovals.set(requestId, entry);

		const inputPreview =
			typeof input === "string" ? input.slice(0, 200) : JSON.stringify(input).slice(0, 200);

		try {
			const res = await fetch(`${TELEGRAM_API}${this.config.telegramToken}/sendMessage`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					chat_id: entry.chatId,
					text: `*Permission Required*\n\nTool: \`${tool}\`\nAction: ${inputPreview}\n\nExpires in ${Math.round(ttl / 60000) || 1} min.`,
					parse_mode: "Markdown",
					...NO_LINK_PREVIEW,
					reply_markup: {
						inline_keyboard: [
							[
								{ text: "Approve", callback_data: `approve:${requestId}` },
								{ text: "Deny", callback_data: `deny:${requestId}` },
							],
							[{ text: "Allow in this chat", callback_data: `allowchat:${requestId}` }],
						],
					},
				}),
			});
			const sent = (await res.json().catch(() => null)) as {
				result?: { message_id?: number };
			} | null;
			entry.messageId = sent?.result?.message_id;
		} catch (err) {
			console.error(
				"[telegram-bridge] failed to send approval request:",
				scrubErr(err, this.config.telegramToken),
			);
		}
	}

	/**
	 * Default-mode prompts run on the adapter's own session, so its approval
	 * cards arrive on that socket, never on this.ws.
	 */
	private watchAdapterApprovals(client: DaemonClient): void {
		client.on("approval:required", (p) => {
			this.sendApprovalRequest(p, "adapter");
		});
	}

	/** Replace a card's buttons with a line saying how it ended. */
	private async closeApprovalCard(p: PendingApproval, status: string): Promise<void> {
		if (!p.messageId) return;
		await fetch(`${TELEGRAM_API}${this.config.telegramToken}/editMessageText`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				chat_id: p.chatId,
				message_id: p.messageId,
				text: `*${status}:* \`${p.tool}\``,
				parse_mode: "Markdown",
				...NO_LINK_PREVIEW,
			}),
		}).catch(() => {});
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
		if (!this.isOperator(query.from?.id)) {
			console.warn(
				`[telegram-bridge] rejected button press from non-operator ${query.from?.id ?? "unknown"}`,
			);
			await fetch(`${TELEGRAM_API}${this.config.telegramToken}/answerCallbackQuery`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					callback_query_id: query.id,
					text: "Only the operator can use these buttons.",
					show_alert: true,
				}),
			}).catch(() => {});
			return;
		}
		// A tap is a turn of its own: everything it triggers belongs here. Set
		// only now, after the chat, sender and operator checks have all passed,
		// so a stranger's tap cannot move where the operator's replies go.
		this.originChatId = String(originChatId);
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
					this.freshSession();
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
		if (action !== "approve" && action !== "deny" && action !== "allowchat") return;
		const approval = this.pendingApprovals.get(requestId);
		if (!approval) {
			// A second press, or a press on a card that was replaced or expired.
			await tgSend(this.config.telegramToken, this.replyChat(), NOT_LIVE);
			return;
		}
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
		if (Date.now() >= approval.expiresAt) {
			await this.closeApprovalCard(approval, "Expired");
			await tgSend(this.config.telegramToken, this.replyChat(), NOT_LIVE);
			return;
		}

		const approved = action !== "deny";
		const scope = action === "allowchat" ? "chat" : undefined;
		await this.closeApprovalCard(
			{ ...approval, messageId: approval.messageId ?? query.message?.message_id },
			scope ? "Allowed in this chat" : approved ? "Approved" : "Denied",
		);

		// The answer goes back on the socket that owns the session; the daemon
		// re-checks it and says so on this.ws when it no longer counts.
		if (approval.via === "adapter" && this.daemonClient) {
			this.daemonClient.respondApproval(requestId, approved, scope);
		} else if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(
				JSON.stringify({
					type: "approval:response",
					requestId,
					approved,
					...(scope ? { scope } : {}),
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
	assertNotAiJamesToken(token, process.env, undefined, authorizedChatIds);
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
	// The 8gent bot must never share the AI James token (one getUpdates lease).

	const authorizedChatIds = splitIds(process.env.TELEGRAM_AUTHORIZED_CHAT_IDS);
	const authorizedUserIds = splitIds(process.env.TELEGRAM_AUTHORIZED_USER_IDS);
	const operatorUserIds = splitIds(process.env.TELEGRAM_OPERATOR_USER_IDS);
	const chatsToWatch = authorizedChatIds.length > 0 ? authorizedChatIds : [chatId];
	// Any bridge with a group allowlisted, and the eightgent bridge always.
	if (botName === "eightgent" || chatsToWatch.some((id) => id.startsWith("-"))) {
		assertNotAiJamesToken(token, process.env, undefined, chatsToWatch);
	}
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
