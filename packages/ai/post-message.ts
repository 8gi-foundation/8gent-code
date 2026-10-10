/**
 * post_message (#3595): post text or a voice note to a Telegram chat through
 * the local helpers ~/.8gent/bin/tg-group and say-telegram.
 *
 * Posting is an outward action, so before anything runs it passes
 *   1. input checks (chat id, text length, voice name),
 *   2. the policy gate (action network_request to api.telegram.org: shadow
 *      deny, exfil-domain and any user YAML rules; email_send is not used, its
 *      COPPA gate wants an age proof no tool executor can supply), then
 *   3. the person, on the same approval card channel the MCP gate uses.
 *      The chat must be on the allowlist in every mode, Infinite included;
 *      Infinite skips only the card, and every post is logged. no card and no TTY means refused.
 * The helpers get argv, never a shell string. They read the bot token
 * themselves; this module never sees it, and everything it returns is
 * scrubbed.
 *
 * Direct send (#3838): when the person names a bot env file in settings
 * (postMessage.botEnvFile), text posts go straight to the Bot API with fetch.
 * The key is read from that file inside this process at send time. It never
 * reaches a command line, the model, a tool result or a log, and text that
 * holds it is refused. The API base is fixed; only the process environment
 * (EIGHT_TG_API_BASE) can change it, never a file the model can write.
 */

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir as osHome } from "node:os";
import { isAbsolute, join } from "node:path";
import { scrub } from "../eight/secret-scanner";
import { getPermissionManager } from "../permissions";
import { ToolG8 } from "../permissions/toolg8";
import { hasTuiApprovalHandler, requestTuiDecision } from "../permissions/tui-approval-channel";

export interface PostMessageArgs {
	chat: string;
	text: string;
	/** Officer voice name (say-telegram --voice); posts a voice note instead of text. */
	voice?: string;
}

export interface PostMessageDeps {
	run: (bin: string, argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
	gate: (chat: string) => { allowed: boolean; reason?: string };
	infinite: () => boolean;
	bins: { text: string; voice: string };
	/** Chats posting is allowed to (settings postMessage.allowedChats). Empty: nothing posts. */
	allowedChats: () => string[];
	/** One line per sent post: chat, length, timestamp. Never the text, never a token. */
	log: (entry: { chat: string; length: number; voice: boolean; at: string }) => void;
	/** Posts allowed per session; `sent` is the session's running count. */
	limit: number;
	sent: { n: number };
	/** Chats a person approved on a card in this process (memory only). */
	approved: Set<string>;
	/** Chats a person declined in this process; not asked again. */
	declined: Set<string>;
	/** Direct Bot API send (#3838); set only when settings name a bot env file. */
	direct?: DirectSend;
}

export interface DirectSend {
	/** True when the text holds the bot key; such text is never sent. */
	holdsKey: (text: string) => boolean;
	send: (chat: string, text: string) => Promise<{ id?: string; error?: string }>;
}

export const POST_LIMIT_PER_SESSION = 10;
const sessions = new Map<string, { n: number }>();

/** HOME at call time: os.homedir() is not re-read when HOME changes. */
const home = () => process.env.HOME || osHome();

/** postMessage.allowedChats from ~/.8gent/settings.json; any fault means the empty list. */
export function readAllowedChats(): string[] {
	try {
		const raw = JSON.parse(readFileSync(join(home(), ".8gent", "settings.json"), "utf8"));
		const list = raw?.postMessage?.allowedChats;
		return Array.isArray(list) ? list.map(String) : [];
	} catch {
		return [];
	}
}

function appendLog(entry: object): void {
	try {
		const dir = join(home(), ".8gent");
		mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, "post-message.log"), `${JSON.stringify(entry)}\n`);
	} catch {
		// the post already needs a person or an allowlist; a log fault must not hide the send
	}
}

/** Where the bot key lives: settings postMessage.botEnvFile and botTokenVar. */
export interface DirectConfig {
	file: string;
	name: string;
}

/** postMessage.botEnvFile from settings; null when unset, relative, or unreadable settings. */
export function readDirectConfig(): DirectConfig | null {
	try {
		const pm = JSON.parse(
			readFileSync(join(home(), ".8gent", "settings.json"), "utf8"),
		)?.postMessage;
		const f = pm?.botEnvFile;
		if (typeof f !== "string" || f.trim() === "") return null;
		const file = f.startsWith("~/") ? join(home(), f.slice(2)) : f;
		if (!isAbsolute(file)) return null;
		const name =
			typeof pm.botTokenVar === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(pm.botTokenVar)
				? pm.botTokenVar
				: "TELEGRAM_BOT_TOKEN";
		return { file, name };
	} catch {
		return null;
	}
}

/** One NAME=value from an env file (export prefix and quotes allowed); null when absent. */
export function readBotKey(file: string, name: string): string | null {
	try {
		for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
			const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
			if (!m || m[1] !== name) continue;
			const value = m[2].replace(/^(['"])(.*)\1$/, "$2");
			return value || null;
		}
	} catch {
		// unreadable file: no key, nothing sends
	}
	return null;
}

const TG_API = "https://api.telegram.org";
/** The Bot API base. Process environment only, so nothing written during a session moves it. */
const apiBase = () => (process.env.EIGHT_TG_API_BASE || TG_API).replace(/\/+$/, "");

function directSend(cfg: DirectConfig): DirectSend {
	const key = () => readBotKey(cfg.file, cfg.name);
	return {
		holdsKey: (text) => {
			const k = key();
			return k !== null && text.includes(k);
		},
		send: async (chat, text) => {
			const k = key();
			if (!k) return { error: `the bot env file has no ${cfg.name}` };
			const hide = (s: string) => s.split(k).join("[redacted-token]");
			try {
				const res = await fetch(`${apiBase()}/bot${k}/sendMessage`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ chat_id: chat, text }),
					// A redirect would carry the key in the path to another host.
					redirect: "error",
					signal: AbortSignal.timeout(30_000),
				});
				const body = (await res.json().catch(() => null)) as {
					ok?: boolean;
					result?: { message_id?: unknown };
					description?: unknown;
				} | null;
				const id = body?.result?.message_id;
				if (res.ok && body?.ok === true && Number.isInteger(id)) return { id: String(id) };
				return {
					error: hide(`HTTP ${res.status}: ${String(body?.description ?? "no description")}`),
				};
			} catch (e) {
				return { error: hide(String((e as Error)?.message ?? e)) };
			}
		},
	};
}

const CHAT_RE = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{3,31})$/;
const VOICE_RE = /^[A-Za-z]{1,24}$/;
const TEXT_MAX = 4096;
const VOICE_MAX = 600;
export const POST_MESSAGE_APPROVAL_ACTION = "Post to Telegram";

/** Offered where the helper is installed, or where settings name a bot env file that exists. */
export function postMessageAvailable(): boolean {
	return (
		existsSync(postMessageBins().text) ||
		(directSnapshot !== null && existsSync(directSnapshot.file))
	);
}

function postMessageBins(): PostMessageDeps["bins"] {
	const bin = process.env.EIGHT_TG_BIN_DIR || join(home(), ".8gent", "bin");
	return { text: join(bin, "tg-group"), voice: join(bin, "say-telegram") };
}

/**
 * allowedChats is read ONCE, when this module loads at process start, and
 * never again: a settings edit made during the session (by an agent that got
 * a write through some other tool) cannot grant a recipient (#3595).
 */
let allowedSnapshot: string[] = readAllowedChats();
/** postMessage.botEnvFile, taken at the same moment and for the same reason. */
let directSnapshot: DirectConfig | null = readDirectConfig();
/**
 * Chats a person approved on a card in THIS process. Memory only: nothing on
 * disk can authorise a post, so nothing an agent can write can either. Every
 * launch starts with none approved. Infinite mode has no person, so it can
 * post only to chats approved earlier in the same process.
 */
const approvedChats = new Set<string>();
const declinedChats = new Set<string>();
/** Test seam only: re-take the allowlist and forget approvals, as a new process would. */
export function _snapshotAllowedChats(): void {
	allowedSnapshot = readAllowedChats();
	directSnapshot = readDirectConfig();
	approvedChats.clear();
	declinedChats.clear();
}

export function postMessageDeps(agentId: string, sessionKey = agentId): PostMessageDeps {
	return {
		run: (file, argv) =>
			new Promise((resolve) => {
				const child = spawn(file, argv, { stdio: ["ignore", "pipe", "pipe"] });
				let stdout = "";
				let stderr = "";
				const timer = setTimeout(() => child.kill("SIGTERM"), 150_000);
				child.stdout.on("data", (d) => {
					stdout += d;
				});
				child.stderr.on("data", (d) => {
					stderr += d;
				});
				child.on("error", (e) => {
					clearTimeout(timer);
					resolve({ code: 127, stdout, stderr: stderr || String(e.message) });
				});
				child.on("close", (code) => {
					clearTimeout(timer);
					resolve({ code: code ?? 1, stdout, stderr });
				});
			}),
		gate: (chat) => {
			const g = ToolG8.instance().gate(agentId, "network_request", {
				// The base this post will call, so policy judges the real destination.
				url: `${directSnapshot ? apiBase() : TG_API}/`,
				to: chat,
			});
			return { allowed: g.allowed || g.requiresApproval === true, reason: g.reason };
		},
		infinite: () => getPermissionManager().isInfiniteMode(),
		bins: postMessageBins(),
		allowedChats: () => allowedSnapshot,
		log: appendLog,
		limit: POST_LIMIT_PER_SESSION,
		approved: approvedChats,
		declined: declinedChats,
		sent: sessions.get(sessionKey) ?? sessions.set(sessionKey, { n: 0 }).get(sessionKey)!,
		direct: directSnapshot ? directSend(directSnapshot) : undefined,
	};
}

/** Ask the person. null means go ahead; otherwise the refusal for the model. */
async function askPerson(args: PostMessageArgs, deps: PostMessageDeps): Promise<string | null> {
	if (deps.infinite()) return null;
	const what = args.voice ? `voice note (${args.voice})` : "message";
	return card(
		POST_MESSAGE_APPROVAL_ACTION,
		`post_message ${what} to chat ${args.chat}:\n${args.text}`,
		`Send this ${what} to Telegram chat ${args.chat}.`,
	);
}

async function card(action: string, command: string, details: string): Promise<string | null> {
	if (hasTuiApprovalHandler()) {
		const decision = await requestTuiDecision({ action, command, full: true, details });
		if (decision === "approve") return null;
		if (decision === "unfit")
			return "[BLOCKED] post_message was not shown for approval: the card must show the whole text and it does not fit on this screen. Nothing was sent. Post shorter text, or ask the person to make the window larger.";
		return "[PERMISSION DENIED] The person declined post_message. Nothing was sent. Do not retry.";
	}
	return "[BLOCKED] post_message needs the person's approval and there is no one to ask in this session. Nothing was sent. Do not retry.";
}

/** Telegram bot tokens (digits:secret), alone or inside a /bot<token>/ URL; the shared scanner has no rule for them. */
const BOT_TOKEN_RE = /(?:bot)?\d{6,}:[A-Za-z0-9_-]{20,}/g;

function clip(s: string): string {
	const flat = s.replace(BOT_TOKEN_RE, "[redacted-token]").replace(/\s+/g, " ").trim();
	return scrub(flat).scrubbed.slice(0, 300);
}

export async function postMessage(args: PostMessageArgs, deps: PostMessageDeps): Promise<string> {
	const { chat, text, voice } = args;
	if (!CHAT_RE.test(chat ?? ""))
		return "[ERROR] chat must be a numeric chat id or an @channelname.";
	if (typeof text !== "string" || text.trim() === "") return "[ERROR] text is empty.";
	if (voice !== undefined && !VOICE_RE.test(voice))
		return "[ERROR] voice must be a plain name such as Rishi.";
	if (text.length > (voice ? VOICE_MAX : TEXT_MAX))
		return `[ERROR] text is ${text.length} characters; the cap is ${voice ? VOICE_MAX : TEXT_MAX}.`;
	// A bot key never leaves in a message, whichever transport sends it.
	BOT_TOKEN_RE.lastIndex = 0;
	if (BOT_TOKEN_RE.test(text) || deps.direct?.holdsKey(text))
		return "[BLOCKED] post_message: the text holds a bot key. Nothing was sent. Remove it; never post credentials.";

	// Attempts count, not only successes: a refused or failed post spends the limit.
	if (deps.sent.n >= deps.limit)
		return `[BLOCKED] post_message: this session has used its ${deps.limit} posts. Nothing was sent.`;
	deps.sent.n++;
	if (!deps.allowedChats().includes(chat))
		return `[BLOCKED] post_message: chat ${chat} is not on postMessage.allowedChats in ~/.8gent/settings.json. Nothing was sent. Ask the person to add it; do not retry.`;

	// On the allowlist is not enough: a person must have approved this chat on a
	// card in this process. Infinite mode has no person to ask.
	if (!deps.approved.has(chat)) {
		if (deps.infinite() || deps.declined.has(chat))
			return `[BLOCKED] post_message: no person has approved chat ${chat} in this session. Nothing was sent. Do not retry.`;
		const refusal = await card(
			"Allow Telegram recipient",
			`post_message wants to post to chat ${chat} for the rest of this session.`,
			`Chat ${chat} is on postMessage.allowedChats. Approve to let post_message use it until this session ends, including when no one is watching.`,
		);
		if (refusal) {
			deps.declined.add(chat);
			return refusal;
		}
		deps.approved.add(chat);
	}

	const g = deps.gate(chat);
	if (!g.allowed)
		return `[BLOCKED] post_message was refused by policy: ${g.reason ?? "no reason given"}. Nothing was sent. Do not retry.`;
	const refusal = await askPerson(args, deps);
	if (refusal) return refusal;

	if (deps.direct && !voice) {
		const r = await deps.direct.send(chat, text);
		if (!r.id) return `[ERROR] post_message failed: ${clip(r.error ?? "") || "no output"}`;
		deps.log({ chat, length: text.length, voice: false, at: new Date().toISOString() });
		return `Posted message to ${chat}, message_id ${r.id}.`;
	}

	const [bin, argv] = voice
		? [deps.bins.voice, ["--voice", voice, "--chat", chat, "--", text]]
		: [deps.bins.text, ["text", "--chat", chat, "--", text]];
	const r = await deps.run(bin, argv);
	const id = r.stdout.trim().split("\n").pop()?.trim() ?? "";
	if (r.code !== 0 || !/^\d+$/.test(id))
		return `[ERROR] post_message failed (exit ${r.code}): ${clip(r.stderr || r.stdout) || "no output"}`;
	deps.log({ chat, length: text.length, voice: Boolean(voice), at: new Date().toISOString() });
	return `Posted ${voice ? "voice note" : "message"} to ${chat}, message_id ${id}.`;
}

/** The text-tool definition; ToolExecutor advertises it only when postMessageAvailable(). */
export const POST_MESSAGE_TOOL_DEF = {
	type: "function",
	function: {
		name: "post_message",
		description:
			"[MESSAGING] Post a message to a Telegram chat, or a voice note when voice is set (say-telegram, officer voice name such as Rishi). Use this, not curl: the bot key is already configured and must never be typed or sourced. Give text, or text_file for a drafted file in the project. The person approves it before it sends. Returns the message id. Send once; do not retry after a refusal. Never put credentials in the text.",
		parameters: {
			type: "object",
			properties: {
				chat: {
					type: "string",
					description: "Telegram chat id, for example -1004417730052, or @channelname",
				},
				text: {
					type: "string",
					description:
						"The message exactly as it should appear (max 4096 characters, 600 for a voice note)",
				},
				text_file: {
					type: "string",
					description:
						"Path inside the project to a file whose contents are the message; used when text is empty",
				},
				voice: {
					type: "string",
					description: "Officer voice name; sends a voice note instead of text",
				},
			},
			required: ["chat"],
		},
	},
};
