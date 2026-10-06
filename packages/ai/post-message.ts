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
 */

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir as osHome } from "node:os";
import { join } from "node:path";
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
	/** Allowlisted chats a person has not yet confirmed at the card (changed since last confirmed). */
	unconfirmed: () => string[];
	/** Record these chats as confirmed by a person. */
	confirm: (chats: string[]) => void;
	/** The confirmation card is shown at most once per process. */
	confirmCard: { shown: boolean };
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

const CHAT_RE = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{3,31})$/;
const VOICE_RE = /^[A-Za-z]{1,24}$/;
const TEXT_MAX = 4096;
const VOICE_MAX = 600;
export const POST_MESSAGE_APPROVAL_ACTION = "Post to Telegram";

/** The tool is offered only where the helper it wraps is installed. */
export function postMessageAvailable(): boolean {
	return existsSync(postMessageBins().text);
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
/**
 * Chats a person has confirmed, in ~/.8gent/post-message-confirmed.json. Only
 * this module writes it, after the card; path-guard keeps agent tools out. A
 * chat in settings but not here is unconfirmed: the settings file may have been
 * changed since a person last looked (the next-launch hole).
 */
function confirmedFile(): string {
	return join(home(), ".8gent", "post-message-confirmed.json");
}
function readConfirmed(): string[] {
	try {
		const list = JSON.parse(readFileSync(confirmedFile(), "utf8"));
		return Array.isArray(list) ? list.map(String) : [];
	} catch {
		return [];
	}
}
let confirmedSnapshot: string[] = readConfirmed();
const confirmCardState = { shown: false };
/** Test seam only: re-take both snapshots and re-arm the card. */
export function _snapshotAllowedChats(): void {
	allowedSnapshot = readAllowedChats();
	confirmedSnapshot = readConfirmed();
	confirmCardState.shown = false;
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
				url: "https://api.telegram.org/",
				to: chat,
			});
			return { allowed: g.allowed || g.requiresApproval === true, reason: g.reason };
		},
		infinite: () => getPermissionManager().isInfiniteMode(),
		bins: postMessageBins(),
		allowedChats: () => allowedSnapshot,
		log: appendLog,
		limit: POST_LIMIT_PER_SESSION,
		unconfirmed: () => allowedSnapshot.filter((c) => !confirmedSnapshot.includes(c)),
		confirm: (chats) => {
			confirmedSnapshot = [...new Set([...confirmedSnapshot, ...chats])];
			try {
				mkdirSync(join(home(), ".8gent"), { recursive: true });
				writeFileSync(confirmedFile(), JSON.stringify(confirmedSnapshot));
			} catch {
				// unwritable: confirmed for this process only; the card returns next launch
			}
		},
		confirmCard: confirmCardState,
		sent: sessions.get(sessionKey) ?? sessions.set(sessionKey, { n: 0 }).get(sessionKey)!,
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
	{
		if (hasTuiApprovalHandler()) {
			const decision = await requestTuiDecision({ action, command, full: true, details });
			if (decision === "approve") return null;
			if (decision === "unfit")
				return "[BLOCKED] post_message was not shown for approval: the card must show the whole text and it does not fit on this screen. Nothing was sent. Post shorter text, or ask the person to make the window larger.";
			return "[PERMISSION DENIED] The person declined post_message. Nothing was sent. Do not retry.";
		}
		return "[BLOCKED] post_message needs the person's approval and there is no one to ask in this session. Nothing was sent. Do not retry.";
	}
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

	// Attempts count, not only successes: a refused or failed post spends the limit.
	if (deps.sent.n >= deps.limit)
		return `[BLOCKED] post_message: this session has used its ${deps.limit} posts. Nothing was sent.`;
	deps.sent.n++;
	if (!deps.allowedChats().includes(chat))
		return `[BLOCKED] post_message: chat ${chat} is not on postMessage.allowedChats in ~/.8gent/settings.json. Nothing was sent. Ask the person to add it; do not retry.`;

	// A chat the settings file gained since a person last confirmed it (an edit
	// made while no one watched) is unconfirmed: refused in Infinite mode, and
	// otherwise shown once on a card listing every unconfirmed chat.
	const un = deps.unconfirmed();
	if (un.includes(chat)) {
		if (deps.infinite() || deps.confirmCard.shown)
			return `[BLOCKED] post_message: chat ${chat} was added to postMessage.allowedChats and a person has not confirmed it yet. Nothing was sent. Do not retry.`;
		deps.confirmCard.shown = true;
		const refusal = await card(
			"Confirm Telegram recipients",
			`post_message recipients not yet confirmed:\n${un.join("\n")}`,
			"These chats are on postMessage.allowedChats but you have not confirmed them. Approve to let post_message use them.",
		);
		if (refusal) return refusal;
		deps.confirm(un);
	}

	const g = deps.gate(chat);
	if (!g.allowed)
		return `[BLOCKED] post_message was refused by policy: ${g.reason ?? "no reason given"}. Nothing was sent. Do not retry.`;
	const refusal = await askPerson(args, deps);
	if (refusal) return refusal;

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
			"[MESSAGING] Post a message to a Telegram chat (local tg-group helper), or a voice note when voice is set (say-telegram, officer voice name such as Rishi). The person approves it before it sends. Returns the message id. Send once; do not retry after a refusal. Never put credentials in the text.",
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
				voice: {
					type: "string",
					description: "Officer voice name; sends a voice note instead of text",
				},
			},
			required: ["chat", "text"],
		},
	},
};
