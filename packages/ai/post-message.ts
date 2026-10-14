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
 * Attachments (#4265): a video, photo, gif or document from inside the
 * project goes out with the text as its caption, through `tg-group
 * video|photo|gif|document` or, with direct send, a multipart upload. Same
 * allowlist, same person, same limit, same log. Files only, never a URL; the
 * caller resolves the path inside the project (safePath) and resolveAttachment
 * checks it is a regular file of a sane size and type. A document that holds
 * a secret is refused like text that holds one.
 *
 * Direct send (#3838): when the person names a bot env file in settings
 * (postMessage.botEnvFile), text posts go straight to the Bot API with fetch.
 * The key is read from that file inside this process at send time. It never
 * reaches a command line, the model, a tool result or a log, and text that
 * holds it is refused. The API base is fixed; only the process environment
 * (EIGHT_TG_API_BASE) can change it, never a file the model can write.
 */

import { spawn } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir as osHome, tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { MAX_SCAN_CHARS, scrub } from "../eight/secret-scanner";
import { getPermissionManager } from "../permissions";
import { configuredBotEnvFile } from "../permissions/path-guard";
import { ToolG8 } from "../permissions/toolg8";
import { hasTuiApprovalHandler, requestTuiDecision } from "../permissions/tui-approval-channel";

export type AttachmentKind = "video" | "photo" | "gif" | "document";

/** A file checked by resolveAttachment: absolute, inside the project, a regular file. */
export interface Attachment {
	/** The project path the person sees on the card. Never read again after the check. */
	path: string;
	kind: AttachmentKind;
	bytes: number;
	/**
	 * The bytes read once at check time; the scan ran on these and these are what
	 * leave. Swapping or relinking the project file after the check changes nothing.
	 */
	data: Buffer;
}

export interface PostMessageArgs {
	chat: string;
	/** The message, or the caption when an attachment is sent (may then be empty). */
	text: string;
	/** Officer voice name (say-telegram --voice); posts a voice note instead of text. */
	voice?: string;
	/** A file to send with text as its caption (#4265). */
	attachment?: Attachment;
}

export interface PostMessageDeps {
	run: (bin: string, argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
	gate: (chat: string) => { allowed: boolean; reason?: string };
	infinite: () => boolean;
	bins: { text: string; voice: string };
	/** Chats posting is allowed to (settings postMessage.allowedChats). Empty: nothing posts. */
	allowedChats: () => string[];
	/** One line per sent post: chat, length, timestamp. Never the text, never a token. */
	log: (entry: {
		chat: string;
		length: number;
		voice: boolean;
		at: string;
		attachment?: { kind: AttachmentKind; bytes: number };
	}) => void;
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
	/** Multipart upload of a checked attachment, text as the caption (#4265). */
	sendFile: (
		chat: string,
		file: Attachment,
		caption: string,
	) => Promise<{ id?: string; error?: string }>;
}

/** Bot API method and form field per kind, the same mapping tg-group uses. */
const ATTACH_API: Record<AttachmentKind, { method: string; field: string }> = {
	video: { method: "sendVideo", field: "video" },
	photo: { method: "sendPhoto", field: "photo" },
	gif: { method: "sendAnimation", field: "animation" },
	document: { method: "sendDocument", field: "document" },
};
const MB = 1024 * 1024;
/** Bot API upload caps: 10 MB for photos, 50 MB for everything else. */
export const ATTACH_MAX_BYTES: Record<AttachmentKind, number> = {
	photo: 10 * MB,
	video: 50 * MB,
	gif: 50 * MB,
	document: 50 * MB,
};
const ATTACH_EXT: Record<AttachmentKind, string[] | null> = {
	photo: [".png", ".jpg", ".jpeg", ".webp"],
	video: [".mp4", ".mov", ".m4v", ".webm"],
	gif: [".gif", ".mp4"],
	document: null,
};
const CAPTION_MAX = 1024;
/**
 * curl -F reads `,` `;` and `"` inside an @path as form syntax: `@a.mp4,/elsewhere/key`
 * uploads a second file from anywhere on disk. Control characters forge lines on the
 * approval card. A path holding any of them is refused.
 */
const unsafePath = (p: string): boolean =>
	/[,;"]/.test(p) ||
	[...p].some((c) => {
		const n = c.charCodeAt(0);
		return n < 32 || n === 127;
	});
/** Chunks overlap so a secret that straddles a chunk edge is still seen whole. */
const SCAN_OVERLAP = 16 * 1024;

/**
 * Every attachment, of every kind and at every size, is scanned before it leaves:
 * a key file renamed to .mp4, a text file with a NUL in front, or a 40 MB log are
 * all read. latin1 keeps bytes 1:1, so ASCII key shapes are found inside binary too.
 * Returns the rules that fired, empty when clean.
 */
function secretsIn(buf: Buffer): string[] {
	const s = buf.toString("latin1");
	const rules = new Set<string>();
	BOT_TOKEN_RE.lastIndex = 0;
	if (BOT_TOKEN_RE.test(s)) rules.add("telegram_bot_token");
	BOT_TOKEN_RE.lastIndex = 0;
	const step = MAX_SCAN_CHARS - SCAN_OVERLAP;
	for (let i = 0; i < s.length; i += step) {
		for (const r of scrub(s.slice(i, i + MAX_SCAN_CHARS)).rules)
			if (r !== "input_cap") rules.add(r);
		if (i + MAX_SCAN_CHARS >= s.length) break;
	}
	return [...rules].sort();
}

/**
 * Write the checked bytes to a private copy for tg-group, so the helper uploads
 * exactly what was scanned and approved. The name keeps only safe characters.
 */
function stageForHelper(a: Attachment): { file?: string; error?: string; done: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "8gent-post-"));
	const done = () => rmSync(dir, { recursive: true, force: true });
	const ext = extname(a.path)
		.toLowerCase()
		.replace(/[^a-z0-9.]/g, "");
	const stem = basename(a.path, extname(a.path))
		.replace(/[^A-Za-z0-9_-]/g, "_")
		.replace(/^[-_]+/, "")
		.slice(0, 80);
	const file = join(dir, `${stem || "file"}${ext}`);
	if (unsafePath(file)) {
		done();
		return { error: "the temp folder path holds a character curl reads as form syntax", done };
	}
	writeFileSync(file, a.data, { mode: 0o600, flag: "wx" });
	return { file, done };
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

/** Env variable names botTokenVar may use: upper case, digits, underscore. */
const TOKEN_VAR_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * postMessage.botEnvFile and botTokenVar from settings. null when the file is
 * unset or relative, or when botTokenVar is set but not a plain upper-case
 * name: a malformed setting disables direct send rather than guessing.
 */
export function readDirectConfig(): DirectConfig | null {
	const file = configuredBotEnvFile(home());
	if (!file) return null;
	try {
		const v = JSON.parse(readFileSync(join(home(), ".8gent", "settings.json"), "utf8"))?.postMessage
			?.botTokenVar;
		if (v === undefined) return { file, name: "TELEGRAM_BOT_TOKEN" };
		return typeof v === "string" && TOKEN_VAR_RE.test(v) ? { file, name: v } : null;
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

/**
 * Check an EIGHT_TG_API_BASE value. Credentials in the URL are always refused;
 * a non-https scheme only under the test runner (local stubs). The value is
 * never echoed back.
 */
export function checkApiBase(raw: string, testMode: boolean): { base?: string; error?: string } {
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return { error: "EIGHT_TG_API_BASE is not a URL" };
	}
	if (u.username || u.password) return { error: "EIGHT_TG_API_BASE must not carry credentials" };
	if (u.protocol !== "https:" && !(testMode && u.protocol === "http:"))
		return { error: "EIGHT_TG_API_BASE must be https" };
	return { base: raw.replace(/\/+$/, "") };
}

const testMode = () => process.env.NODE_ENV === "test" || process.env.BUN_TEST === "1";

/** The Bot API base. Process environment only, so nothing written during a session moves it. */
const apiBase = (): { base?: string; error?: string } => {
	const raw = process.env.EIGHT_TG_API_BASE;
	return raw ? checkApiBase(raw, testMode()) : { base: TG_API };
};

function directSend(cfg: DirectConfig): DirectSend {
	const key = () => readBotKey(cfg.file, cfg.name);
	const call = async (
		method: string,
		build: () => { headers?: Record<string, string>; body: string | FormData },
		timeoutMs: number,
	): Promise<{ id?: string; error?: string }> => {
		const api = apiBase();
		if (!api.base) return { error: api.error };
		const k = key();
		if (!k) return { error: `the bot env file has no ${cfg.name}` };
		const forms = [k, encodeURIComponent(k), encodeURIComponent(k).toLowerCase()];
		const hide = (s: string) => forms.reduce((t, f) => t.split(f).join("[redacted-token]"), s);
		try {
			const res = await fetch(`${api.base}/bot${k}/${method}`, {
				method: "POST",
				...build(),
				// A redirect would carry the key in the path to another host.
				redirect: "error",
				signal: AbortSignal.timeout(timeoutMs),
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
	};
	return {
		holdsKey: (text) => {
			const k = key();
			return k !== null && text.includes(k);
		},
		send: (chat, text) =>
			call(
				"sendMessage",
				() => ({
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ chat_id: chat, text }),
				}),
				30_000,
			),
		sendFile: (chat, file, caption) =>
			call(
				ATTACH_API[file.kind].method,
				() => {
					const form = new FormData();
					form.set("chat_id", chat);
					if (caption) form.set("caption", caption);
					form.set(
						ATTACH_API[file.kind].field,
						new Blob([new Uint8Array(file.data)]),
						basename(file.path),
					);
					return { body: form };
				},
				150_000,
			),
	};
}

/**
 * Check a model-supplied attachment {path, kind}. resolveInProject is the
 * caller's workspace resolver (safePath): it throws for a path outside the
 * project, through a symlink out of it, or onto a protected credential file.
 * Returns the checked attachment, or the refusal for the model.
 */
export function resolveAttachment(
	raw: unknown,
	resolveInProject: (p: string) => string,
): { attachment?: Attachment; error?: string } {
	const a = typeof raw === "string" ? safeJson(raw) : raw;
	const rawPath = (a as { path?: unknown } | null)?.path;
	const kind = (a as { kind?: unknown } | null)?.kind;
	if (typeof rawPath !== "string" || rawPath.trim() === "")
		return { error: "[ERROR] attachment needs {path, kind}: path is a file inside the project." };
	if (typeof kind !== "string" || !(kind in ATTACH_API))
		return { error: "[ERROR] attachment kind must be video, photo, gif or document." };
	const k = kind as AttachmentKind;
	if (/^[a-z][a-z0-9+.-]+:/i.test(rawPath.trim()))
		return {
			error:
				"[BLOCKED] post_message sends files from the project only, never a URL. Nothing was sent. Save the file inside the project first.",
		};
	if (unsafePath(rawPath))
		return {
			error:
				'[BLOCKED] post_message: the attachment path holds a comma, semicolon, quote or control character. Nothing was sent. Rename the file to letters, digits, "-", "_" and "." first.',
		};
	let file: string;
	try {
		file = resolveInProject(rawPath.trim());
	} catch (e) {
		return {
			error: `[BLOCKED] post_message: attachment ${clip(String((e as Error)?.message ?? e))} Nothing was sent. Do not retry with another path outside the project.`,
		};
	}
	if (unsafePath(file))
		return {
			error:
				'[BLOCKED] post_message: the attachment resolves to a path holding a comma, semicolon, quote or control character. Nothing was sent. Rename the file to letters, digits, "-", "_" and "." first.',
		};
	let st: ReturnType<typeof statSync>;
	try {
		st = statSync(file);
	} catch {
		return { error: `[ERROR] attachment not found: ${rawPath}. Nothing was sent.` };
	}
	if (!st.isFile())
		return { error: `[ERROR] attachment is not a file: ${rawPath}. Nothing was sent.` };
	if (st.size === 0) return { error: `[ERROR] attachment is empty: ${rawPath}. Nothing was sent.` };
	const max = ATTACH_MAX_BYTES[k];
	if (st.size > max)
		return {
			error: `[ERROR] attachment is ${(st.size / MB).toFixed(1)} MB; the cap for a ${k} is ${max / MB} MB. Nothing was sent. Make it smaller first.`,
		};
	const exts = ATTACH_EXT[k];
	const ext = extname(file).toLowerCase();
	if (exts && !exts.includes(ext))
		return {
			error: `[ERROR] a ${k} attachment must be ${exts.join(", ")}; got "${ext || "no extension"}". Send it as kind document instead.`,
		};
	// Read once. The scan, the size and the send all use these bytes, never the path again.
	let data: Buffer;
	try {
		data = readFileSync(file);
	} catch {
		return { error: `[ERROR] attachment could not be read: ${rawPath}. Nothing was sent.` };
	}
	if (data.length !== st.size || data.length > max)
		return { error: `[ERROR] attachment changed while it was read: ${rawPath}. Nothing was sent.` };
	const found = secretsIn(data);
	if (found.length > 0)
		return {
			error: `[BLOCKED] post_message: the attachment holds a secret (${found.join(", ")}). Nothing was sent. Never post credentials.`,
		};
	return { attachment: { path: file, kind: k, bytes: data.length, data } };
}

function safeJson(s: string): unknown {
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
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
				url: `${(directSnapshot && apiBase().base) || TG_API}/`,
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
	const a = args.attachment;
	const what = a
		? `${a.kind} ${basename(a.path)} (${Math.max(1, Math.round(a.bytes / 1024))} KB)`
		: args.voice
			? `voice note (${args.voice})`
			: "message";
	const body = a ? `\nfile: ${a.path}\ncaption: ${args.text || "(none)"}` : `:\n${args.text}`;
	return card(
		POST_MESSAGE_APPROVAL_ACTION,
		`post_message ${what} to chat ${args.chat}${body}`,
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
	const { chat, text, voice, attachment } = args;
	if (!CHAT_RE.test(chat ?? ""))
		return "[ERROR] chat must be a numeric chat id or an @channelname.";
	if (typeof text !== "string" || (text.trim() === "" && !attachment))
		return "[ERROR] text is empty.";
	if (voice !== undefined && attachment)
		return "[ERROR] send a voice note or an attachment, not both.";
	if (voice !== undefined && !VOICE_RE.test(voice))
		return "[ERROR] voice must be a plain name such as Rishi.";
	const cap = attachment ? CAPTION_MAX : voice ? VOICE_MAX : TEXT_MAX;
	if (text.length > cap)
		return `[ERROR] ${attachment ? "caption" : "text"} is ${text.length} characters; the cap is ${cap}.`;
	// A bot key never leaves in a message, whichever transport sends it.
	BOT_TOKEN_RE.lastIndex = 0;
	if (BOT_TOKEN_RE.test(text) || deps.direct?.holdsKey(text))
		return "[BLOCKED] post_message: the text holds a bot key. Nothing was sent. Remove it; never post credentials.";
	// Any other secret the shared scanner knows (an API key from a workspace .env, say).
	const found = scrub(text);
	if (found.redactedCount > 0)
		return `[BLOCKED] post_message: the text holds a secret (${found.rules.join(", ")}). Nothing was sent. Remove it; never post credentials.`;

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

	if (attachment) {
		let r: { id?: string; error?: string };
		if (deps.direct) r = await deps.direct.sendFile(chat, attachment, text);
		else {
			const staged = stageForHelper(attachment);
			try {
				r = staged.file
					? await runBin(deps, [
							attachment.kind,
							"--chat",
							chat,
							"--file",
							staged.file,
							...(text ? ["--caption", text] : []),
						])
					: { error: staged.error };
			} finally {
				staged.done();
			}
		}
		if (!r.id) return `[ERROR] post_message failed: ${clip(r.error ?? "") || "no output"}`;
		deps.log({
			chat,
			length: text.length,
			voice: false,
			at: new Date().toISOString(),
			attachment: { kind: attachment.kind, bytes: attachment.bytes },
		});
		return `Posted ${attachment.kind} ${basename(attachment.path)} to ${chat}, message_id ${r.id}.`;
	}

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

/** tg-group with argv; the last stdout line is the message id. */
async function runBin(
	deps: PostMessageDeps,
	argv: string[],
): Promise<{ id?: string; error?: string }> {
	const r = await deps.run(deps.bins.text, argv);
	const id = r.stdout.trim().split("\n").pop()?.trim() ?? "";
	if (r.code !== 0 || !/^\d+$/.test(id))
		return { error: `(exit ${r.code}) ${r.stderr || r.stdout}` };
	return { id };
}

/** The text-tool definition; ToolExecutor advertises it only when postMessageAvailable(). */
export const POST_MESSAGE_TOOL_DEF = {
	type: "function",
	function: {
		name: "post_message",
		description:
			"[MESSAGING] Posts {chat, text} to Telegram; add attachment:{path, kind} for a file or voice:'Rishi' for a voice note. Attachment kind is video, photo, gif or document; path is a file inside the project, never a URL, and text becomes its caption. Give text, or text_file for a drafted file in the project. Use this, not curl: the bot key is already configured and must never be typed or sourced. The person approves it before it sends. Returns the message id. Send once; do not retry after a refusal. Never put credentials in the text.",
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
				attachment: {
					type: "object",
					description:
						"A file to send, text as its caption: {path, kind}. path inside the project (no URLs); kind video (mp4, mov, webm), photo (png, jpg, webp; 10 MB), gif, or document (any file). 50 MB cap.",
					properties: {
						path: { type: "string", description: "File path inside the project" },
						kind: { type: "string", enum: ["video", "photo", "gif", "document"] },
					},
					required: ["path", "kind"],
				},
			},
			required: ["chat"],
		},
	},
};
