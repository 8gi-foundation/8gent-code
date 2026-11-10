/**
 * @8gent/eight - term-session-list.ts (#180)
 *
 * What the model is told about the terminal sessions THIS app opened: the
 * notice when the person opens one with /term, and the list every turn after.
 *
 * Only sessions in the #148 registry (term-tools.ts ownedSessions) are ever
 * named, so a session this app did not open cannot appear. They are tmux
 * sessions, so the model can read them with term_read and type to them with
 * term_send.
 *
 * Built from real state each time: tmux is asked whether the session is alive
 * and the log tail is read. Nothing here is cached text.
 */

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { hasTmuxSession, stripControl } from "../terminal-tab/index.js";
import { scrub } from "./secret-scanner.js";
import { type OwnedSession, ownedSessions } from "./term-tools.js";

/** Most sessions listed per turn. Ten is the agent pool's own ceiling; eight keeps the note near 1 KB. */
export const MAX_LISTED = 8;
/** Characters of a session name shown. */
export const MAX_NAME = 40;
/** Characters of "what was started in it" shown. */
export const MAX_STARTED = 80;
/** Characters of the last output line shown. */
export const MAX_LAST_LINE = 120;
/** Control, bidi and zero-width characters: removed from a program's output before the model sees it. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
const UNSAFE = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the escape byte is the point
const SGR = /\x1b\[[0-9;]*m/g;
/** Bytes read from the end of a session log to find its last line. */
const TAIL_BYTES = 4096;

/** The session /term opened, as the notice needs it. */
export type NoticeSession = Pick<OwnedSession, "target" | "label" | "command" | "args" | "pid">;

/** The one line the app says right after /term opens a session: its real name, id, pid and state. */
export async function openedLine(
	s: NoticeSession,
	tmuxAlive: (id: string) => Promise<boolean> = hasTmuxSession,
): Promise<string> {
	const state = (await tmuxAlive(s.target)) ? "running" : "exited";
	return `Opened ${clip(s.label, MAX_NAME)}: session ${s.target}, pid ${s.pid}, ${state}. I can read it and send to it.`;
}

/**
 * The event delivered to the model right after the person opens a session with
 * /term. Every value is the session's own: name, id, pid, what was started, and
 * whether tmux says it is running now.
 */
export async function sessionOpenedNotice(
	s: NoticeSession,
	tmuxAlive: (id: string) => Promise<boolean> = hasTmuxSession,
): Promise<string> {
	const state = (await tmuxAlive(s.target)) ? "running" : "exited";
	const started = clip(scrub([s.command, ...s.args].join(" ")).scrubbed, MAX_STARTED);
	return `The person just opened a terminal session with /term: name ${clip(s.label, MAX_NAME)}, id ${s.target}, pid ${s.pid}, started: ${started}, state ${state}. You can read it with term_read {sessionId} and type to it with term_send {sessionId, text}, using that id. Read its current output now, then tell the person what session you have and what it shows.`;
}

/** The event when /term could not start a session. */
export function sessionFailedNotice(label: string, reason: string): string {
	return `The person tried to open a terminal session with /term (${clip(label, MAX_NAME)}) and it failed to start: ${clip(scrub(reason).scrubbed, MAX_LAST_LINE)}. No session exists. Tell the person it failed and why.`;
}

function clip(text: string, max: number): string {
	const one = text.replace(/\s+/g, " ").trim();
	return one.length > max ? `${one.slice(0, max - 3)}...` : one;
}

/** Last non-empty line of the final TAIL_BYTES of a log, control sequences removed, secrets scrubbed. */
export function lastLineOf(logPath: string): string | null {
	try {
		if (!existsSync(logPath)) return null;
		const size = statSync(logPath).size;
		const start = Math.max(0, size - TAIL_BYTES);
		const buf = Buffer.alloc(size - start);
		const fd = openSync(logPath, "r");
		try {
			readSync(fd, buf, 0, buf.length, start);
		} finally {
			closeSync(fd);
		}
		// stripControl keeps colour codes; none belong in a one-line summary, and no
		// control or bidi character should reach the model from a program's output.
		const lines = stripControl(buf.toString("utf-8"))
			.replace(SGR, "")
			.replace(UNSAFE, "")
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter(Boolean);
		const last = lines[lines.length - 1];
		if (!last) return null;
		return clip(scrub(last).scrubbed, MAX_LAST_LINE);
	} catch {
		return null;
	}
}

interface Row {
	name: string;
	id: string;
	pid: number;
	started: string;
	state: "running" | "exited";
	tail: string;
	at: number;
}

/**
 * The block for this turn, or "" when this app has opened no sessions (no
 * heading, nothing). `tmuxAlive` is injectable for tests.
 */
export async function termSessionBlock(
	tmuxAlive: (id: string) => Promise<boolean> = hasTmuxSession,
): Promise<string> {
	const rows: Row[] = [];
	for (const s of ownedSessions()) {
		const alive = await tmuxAlive(s.target);
		const last = lastLineOf(s.logPath);
		rows.push({
			name: s.label,
			id: s.target,
			pid: s.pid,
			started: [s.command, ...s.args].join(" "),
			state: alive ? "running" : "exited",
			tail: last ? `last line: ${last}` : "no output yet",
			at: Date.parse(s.createdAt) || 0,
		});
	}
	if (rows.length === 0) return "";
	rows.sort((a, b) => a.at - b.at);
	const shown = rows.slice(-MAX_LISTED);
	const hidden = rows.length - shown.length;
	const lines = shown.map((r) => {
		const pid = r.pid > 0 ? `pid ${r.pid}` : "pid not captured";
		const started = clip(scrub(r.started).scrubbed, MAX_STARTED);
		return `- ${clip(r.name, MAX_NAME)} | id ${r.id} | ${pid} | started: ${started} | ${r.state} | ${r.tail}`;
	});
	return [
		"Terminal sessions this app opened (name, id, pid, what was started, state, last output):",
		...lines,
		...(hidden > 0 ? [`(${hidden} older not shown)`] : []),
		"Read one with term_read {sessionId} and type to it with term_send {sessionId, text}. Answer questions about a session from this list.",
	].join("\n");
}

/**
 * What /term does around opening a session: open it, put its tab up, say the one
 * line in the chat, and tell the model once (one notice per session, so one turn
 * from it). A failed open says so and tells the model it failed. Delivery goes
 * through the app's ordinary submit, so a turn already running takes the notice
 * as a steer, or it queues behind it: two quick opens never start two turns.
 */
export async function openAndAnnounce(
	open: () => Promise<OwnedSession>,
	label: string,
	hooks: {
		addTab: (s: OwnedSession) => void;
		say: (line: string) => void;
		tellModel: (notice: string) => void;
	},
	tmuxAlive: (id: string) => Promise<boolean> = hasTmuxSession,
): Promise<void> {
	let s: OwnedSession;
	try {
		s = await open();
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		hooks.say(`Failed to open ${clip(label, MAX_NAME)} in a terminal session: ${why}`);
		hooks.tellModel(sessionFailedNotice(label, why));
		return;
	}
	hooks.addTab(s);
	hooks.say(await openedLine(s, tmuxAlive));
	hooks.tellModel(await sessionOpenedNotice(s, tmuxAlive));
}
