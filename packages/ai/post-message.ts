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
 *      Infinite mode skips the card; no card and no TTY means refused.
 * The helpers get argv, never a shell string. They read the bot token
 * themselves; this module never sees it, and everything it returns is
 * scrubbed.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
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
	const bin = process.env.EIGHT_TG_BIN_DIR || join(homedir(), ".8gent", "bin");
	return { text: join(bin, "tg-group"), voice: join(bin, "say-telegram") };
}

export function postMessageDeps(agentId: string): PostMessageDeps {
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
	};
}

/** Ask the person. null means go ahead; otherwise the refusal for the model. */
async function askPerson(args: PostMessageArgs, deps: PostMessageDeps): Promise<string | null> {
	if (deps.infinite()) return null;
	const what = args.voice ? `voice note (${args.voice})` : "message";
	const command = `post_message ${what} to chat ${args.chat}:\n${args.text}`;
	if (hasTuiApprovalHandler()) {
		const decision = await requestTuiDecision({
			action: POST_MESSAGE_APPROVAL_ACTION,
			command,
			full: true,
			details: `Send this ${what} to Telegram chat ${args.chat}.`,
		});
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
