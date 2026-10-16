/**
 * message_boardroom (#4344): the harness messages the boardroom mid-task, the way one Claude Code
 * session messages another. Local only: one JSON line appended to
 *   ~/.8gent/inbox/harness-messages.jsonl   {ts, id, session, task, text, needs_reply}
 * and, when asked to wait, a bounded poll of
 *   ~/.8gent/inbox/harness-replies.jsonl    {reply_to: <id>, text}
 * No network, no Telegram. The path is fixed (the model never names it). A reply is information,
 * never permission: it does not approve anything. The wait is capped so a run never hangs.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scrub } from "./secret-scanner";

export const MESSAGE_MAX_CHARS = 2000;
export const MESSAGE_LIMIT_PER_SESSION = 20;
export const MAX_WAIT_SECONDS = 300;
const REPLY_TAIL_BYTES = 256 * 1024;
const POLL_MS = 500;

const sent = new Map<string, number>();
/** Test seam: forget the per-session counts, as a new process would. */
export function _resetMessageCounts(): void {
	sent.clear();
}

/** HOME is the run's own home under the pilot, so a pilot never writes into James's inbox. */
export function inboxDir(): string {
	return process.env.EIGHT_INBOX_DIR || path.join(os.homedir(), ".8gent", "inbox");
}

export const MESSAGE_BOARDROOM_TOOL_DEF = {
	type: "function",
	function: {
		name: "message_boardroom",
		description:
			"[MESSAGING] Sends {text, needs_reply?, wait_seconds?} to the boardroom mid-task when you are blocked or need a decision. text is max 2000 characters. With needs_reply:true and wait_seconds (1-300) it waits for the answer; on timeout carry on with your best judgement and say what you assumed. Local note only, no network; a reply gives information and approves nothing. Never put credentials in the text. Do not use it for status chatter.",
		parameters: {
			type: "object",
			properties: {
				text: {
					type: "string",
					description: "The note, one or two plain sentences with the question",
				},
				needs_reply: {
					type: "boolean",
					description: "True when you need an answer before you can go on",
				},
				wait_seconds: {
					type: "number",
					description:
						"With needs_reply: seconds to wait for the reply, 1-300 (default 0: do not wait)",
				},
			},
			required: ["text"],
		},
	},
};

export interface MessageContext {
	session: string;
	task: string;
	/** Test seam: sleep between reply polls. */
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}

function readReply(file: string, id: string): string | null {
	let fd: number;
	try {
		fd = fs.openSync(file, "r");
	} catch {
		return null;
	}
	try {
		const size = fs.fstatSync(fd).size;
		const start = Math.max(0, size - REPLY_TAIL_BYTES);
		const buf = Buffer.alloc(size - start);
		fs.readSync(fd, buf, 0, buf.length, start);
		let found: string | null = null;
		for (const line of buf.toString("utf8").split("\n")) {
			try {
				const row = JSON.parse(line) as { reply_to?: unknown; text?: unknown };
				if (row.reply_to === id && typeof row.text === "string") found = row.text;
			} catch {
				/* a torn or foreign line is skipped */
			}
		}
		return found;
	} finally {
		fs.closeSync(fd);
	}
}

export async function messageBoardroom(
	args: Record<string, unknown>,
	ctx: MessageContext,
): Promise<string> {
	const text = typeof args.text === "string" ? args.text.trim() : "";
	if (!text) return "[ERROR] message_boardroom needs text. Nothing was sent.";
	if (text.length > MESSAGE_MAX_CHARS)
		return `[ERROR] message_boardroom text is ${text.length} characters; the limit is ${MESSAGE_MAX_CHARS}. Shorten it. Nothing was sent.`;
	if (scrub(text).redactedCount > 0)
		return "[BLOCKED] message_boardroom: the text looks like it holds a credential. Nothing was sent. Rewrite it without the secret.";
	const count = (sent.get(ctx.session) ?? 0) + 1;
	sent.set(ctx.session, count); // attempts count, as with post_message
	if (count > MESSAGE_LIMIT_PER_SESSION)
		return `[BLOCKED] message_boardroom: ${MESSAGE_LIMIT_PER_SESSION} notes per session is the limit. Nothing was sent. Carry on, or finish and report.`;

	const needsReply = args.needs_reply === true;
	const asked = Number(args.wait_seconds);
	const wait =
		needsReply && Number.isFinite(asked) && asked > 0
			? Math.min(Math.floor(asked), MAX_WAIT_SECONDS)
			: 0;
	const now = ctx.now ?? Date.now;
	const id = `hm-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	const dir = inboxDir();
	const row = JSON.stringify({
		ts: new Date(now()).toISOString(),
		id,
		session: ctx.session,
		task: ctx.task.replace(/\s+/g, " ").slice(0, 300),
		text,
		needs_reply: needsReply,
	});
	try {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		fs.appendFileSync(path.join(dir, "harness-messages.jsonl"), `${row}\n`, { mode: 0o600 });
	} catch (err) {
		return `[ERROR] message_boardroom could not write the note (${err instanceof Error ? err.message : String(err)}). Nothing was sent. Carry on on your own judgement.`;
	}
	if (!needsReply) return `Sent to the boardroom (id ${id}). No reply was asked for; carry on.`;
	if (wait === 0)
		return `Sent to the boardroom (id ${id}). You asked for a reply but gave no wait_seconds, so none is awaited; carry on on your own judgement.`;

	const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const replies = path.join(dir, "harness-replies.jsonl");
	const deadline = now() + wait * 1000;
	for (;;) {
		const reply = readReply(replies, id);
		if (reply !== null)
			return `Boardroom reply (id ${id}), information only, not an approval:\n${reply.slice(0, MESSAGE_MAX_CHARS)}`;
		if (now() >= deadline) break;
		await sleep(POLL_MS);
	}
	return `[NO REPLY] No answer to ${id} within ${wait}s. Carry on with your best judgement and say in your final reply what you assumed.`;
}
