/**
 * Open-session record (#196): which sessions were open when 8gent Code last
 * stopped, so the next start can offer to bring them back.
 *
 * The conversation itself already survives a restart (session-store.ts, the
 * /resume picker). What was missing is the one fact "this session was still
 * open": a clean quit and a Mac restart look the same on disk. So each running
 * process keeps one small file, <sessions dir>/open/<pid>.json, naming the
 * session it has open. A deliberate quit removes it. A restart or a kill
 * leaves it behind, and the next start finds it with no live process behind it.
 *
 * Local only, no secret in the file (ids, pid, boot time). Nothing here starts
 * a session: offerRestore asks, default No, and does nothing without a person.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { redact } from "../memory/redact.js";
import { sanitizeForDisplay } from "./changelog-view.js";
import { chatMessages } from "./session-messages.js";
import { SessionStore, defaultSessionsDir, isSessionId, listSessions } from "./session-store.js";

interface OpenRecord {
	pid: number;
	sessionId: string;
	/** Machine boot time in epoch seconds, so a reused pid after a restart is not mistaken for a live process. */
	bootAt: number;
}

export interface RestorableSession {
	id: string;
	name?: string;
	cwd: string;
	lastActiveAt: string;
	/** The last thing the person typed: control bytes removed, secrets redacted, short; empty when none. */
	lastUserMessage: string;
}

export interface OpenOpts {
	dir?: string;
	pid?: number;
	bootAt?: number;
}

const BOOT_TOLERANCE_SECONDS = 120;
/** A record older than this with no process behind it is dropped, not offered. */
export const MAX_STALE_AGE_MS = 30 * 24 * 3600 * 1000;
const PREVIEW_CHARS = 80;

/**
 * Text from a session record, made safe to print: control and escape bytes
 * removed, secrets redacted (in that order, so an escape byte cannot split a
 * token past the redactor), one line, cut after redaction.
 */
export function safeLine(text: string, max = 200): string {
	const one = redact(sanitizeForDisplay(text).replace(/\s+/g, " ").trim());
	return one.length > max ? `${one.slice(0, max)}...` : one;
}

/** Quote one word for a POSIX shell: single quotes, embedded single quotes escaped. */
export function shellQuote(word: string): string {
	return `'${word.replace(/'/g, `'\\''`)}'`;
}

const hasControl = (s: string) => /[\x00-\x1f\x7f-\x9f]/.test(s);

/** The command that reopens a session in its folder, safe to paste. A folder with control bytes is left out. */
export function reopenCommand(s: Pick<RestorableSession, "id" | "cwd">): string {
	const resume = `8gent --resume ${s.id}`;
	return hasControl(s.cwd) ? resume : `cd ${shellQuote(s.cwd)} && ${resume}`;
}

export const currentBootAt = (): number => Math.round(Date.now() / 1000 - os.uptime());
const openDir = (dir: string) => path.join(dir, "open");
const recordFile = (dir: string, pid: number) => path.join(openDir(dir), `${pid}.json`);

/** Record that this process has `sessionId` open. A later call replaces the earlier one. */
export function markOpen(sessionId: string, opts: OpenOpts = {}): void {
	if (!isSessionId(sessionId)) return;
	const dir = opts.dir ?? defaultSessionsDir();
	const pid = opts.pid ?? process.pid;
	const rec: OpenRecord = { pid, sessionId, bootAt: opts.bootAt ?? currentBootAt() };
	try {
		fs.mkdirSync(openDir(dir), { recursive: true, mode: 0o700 });
		fs.writeFileSync(recordFile(dir, pid), JSON.stringify(rec), { mode: 0o600 });
		// This session is open again: the dead process's record has done its job.
		for (const o of readRecords(dir)) {
			if (o.rec.pid !== pid && o.rec.sessionId === sessionId && !isRunning(o.rec, rec.bootAt)) {
				fs.rmSync(o.file, { force: true });
			}
		}
	} catch {
		// A read-only home must not stop the app; the session still saves on its own.
	}
}

/** A deliberate quit: this process no longer has a session open. */
export function markClosed(opts: OpenOpts = {}): void {
	const dir = opts.dir ?? defaultSessionsDir();
	fs.rmSync(recordFile(dir, opts.pid ?? process.pid), { force: true });
}

function readRecords(dir: string): Array<{ file: string; rec: OpenRecord; mtimeMs: number }> {
	let names: string[];
	try {
		names = fs.readdirSync(openDir(dir));
	} catch {
		return [];
	}
	const out: Array<{ file: string; rec: OpenRecord; mtimeMs: number }> = [];
	for (const n of names) {
		const file = path.join(openDir(dir), n);
		try {
			const r = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<OpenRecord>;
			if (Number.isInteger(r.pid) && isSessionId(r.sessionId) && typeof r.bootAt === "number") {
				out.push({ file, rec: r as OpenRecord, mtimeMs: fs.statSync(file).mtimeMs });
			} else fs.rmSync(file, { force: true });
		} catch {
			fs.rmSync(file, { force: true });
		}
	}
	return out;
}

function isRunning(rec: OpenRecord, bootAt: number): boolean {
	if (Math.abs(rec.bootAt - bootAt) > BOOT_TOLERANCE_SECONDS) return false;
	try {
		process.kill(rec.pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Sessions that were open when 8gent Code last stopped and have a conversation
 * to come back to, newest first. A session held by a live process is left out,
 * as is one with no messages. Reading only: nothing is removed here.
 */
export function restorableSessions(opts: OpenOpts = {}): RestorableSession[] {
	const dir = opts.dir ?? defaultSessionsDir();
	const bootAt = opts.bootAt ?? currentBootAt();
	const records = readRecords(dir);
	const live = new Set(records.filter((r) => isRunning(r.rec, bootAt)).map((r) => r.rec.sessionId));
	const stale = new Set(
		records
			.filter((r) => !isRunning(r.rec, bootAt) && Date.now() - r.mtimeMs < MAX_STALE_AGE_MS)
			.map((r) => r.rec.sessionId),
	);
	const out: RestorableSession[] = [];
	for (const s of listSessions({ sessionsDir: dir })) {
		if (!stale.has(s.id) || live.has(s.id)) continue;
		out.push({
			id: s.id,
			...(s.name !== undefined ? { name: safeLine(s.name, 60) } : {}),
			cwd: s.cwd,
			lastActiveAt: s.lastActiveAt,
			lastUserMessage: lastUserLine(s.id, dir),
		});
	}
	return out;
}

/** Forget every record with no live process, except the sessions named in `keep`. */
export function forgetStale(opts: OpenOpts = {}, keep: ReadonlySet<string> = new Set()): void {
	const dir = opts.dir ?? defaultSessionsDir();
	const bootAt = opts.bootAt ?? currentBootAt();
	for (const { file, rec } of readRecords(dir)) {
		if (!isRunning(rec, bootAt) && !keep.has(rec.sessionId)) fs.rmSync(file, { force: true });
	}
}

function lastUserLine(id: string, dir: string): string {
	try {
		const msgs = chatMessages(SessionStore.open(id, dir)?.messages() ?? []);
		for (let i = msgs.length - 1; i >= 0; i--) {
			if (msgs[i].role === "user") {
				return safeLine(String(msgs[i].content), PREVIEW_CHARS);
			}
		}
	} catch {
		// unreadable record: list the session without a last message
	}
	return "";
}

export interface RestoreIo {
	/** True only with a person at the terminal (the caller folds in CI and EIGHT_UNATTENDED). */
	interactive: boolean;
	write(line: string): void;
	/** Resolves the person's answer line. */
	ask(question: string): Promise<string>;
	/** How long to wait for an answer; an unanswered question is No. Default: no limit (tests); index.tsx passes oneYesTimeoutMs(). */
	timeoutMs?: number;
}

const TIMED_OUT = Symbol("timed out");

async function askWithin(io: RestoreIo, question: string): Promise<string | typeof TIMED_OUT> {
	if (io.timeoutMs === undefined) return io.ask(question);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const limit = new Promise<typeof TIMED_OUT>((r) => {
		timer = setTimeout(() => r(TIMED_OUT), io.timeoutMs);
	});
	try {
		return await Promise.race([io.ask(question), limit]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * On start: say which sessions were open, ask about each (default No), and
 * return the sessions the person accepted, newest first. Unattended returns [] and
 * leaves the record alone, so the next interactive start still offers them.
 */
export async function offerRestore(io: RestoreIo, opts: OpenOpts = {}): Promise<RestorableSession[]> {
	const found = restorableSessions(opts);
	if (!io.interactive) return [];
	if (found.length === 0) {
		forgetStale(opts);
		return [];
	}
	io.write(
		found.length === 1
			? "1 session was open when 8gent Code last stopped:"
			: `${found.length} sessions were open when 8gent Code last stopped:`,
	);
	const accepted: RestorableSession[] = [];
	for (const s of found) {
		const label = s.name ? `${s.name} (${s.id})` : s.id;
		const last = s.lastUserMessage ? ` last message: "${s.lastUserMessage}"` : "";
		const folder = hasControl(s.cwd) ? "(folder name not shown)" : safeLine(s.cwd, 120);
		io.write(`  ${label}  ${folder}  last active ${s.lastActiveAt}${last}`);
		const a = await askWithin(io, "  Resume it and open it in that folder? [y/N] ");
		if (a === TIMED_OUT) {
			// Nobody answered: that is No, for this and the rest. Nothing is forgotten, so a person is asked next time.
			io.write(`\n  No answer in ${Math.round((io.timeoutMs ?? 0) / 1000)} s: nothing was resumed.`);
			return [];
		}
		const yes = a.trim().toLowerCase();
		if (yes === "y" || yes === "yes") accepted.push(s);
	}
	// A No is forgotten now. A Yes stays until its resume has happened (markOpen) or its command was shown.
	forgetStale(opts, new Set(accepted.map((a) => a.id)));
	return accepted;
}

export interface StartRestore {
	/** Session id to hand to the app as --resume, if one was resumed. */
	sessionResume?: string;
	/** Yeses after the first: shown with finishRestore after the app exits, where they stay visible. */
	later: RestorableSession[];
}

/**
 * The whole start-up step: offer, then enter the first accepted session's
 * folder. Never throws. If the folder cannot be entered the session is not
 * resumed and its record stays, so it is offered again; one plain line says so.
 * A folder whose name was not shown is not entered, and the session resumes
 * where 8gent Code was launched, which the line says.
 */
export async function restoreOnStart(io: RestoreIo, opts: OpenOpts = {}): Promise<StartRestore> {
	let accepted: RestorableSession[];
	try {
		accepted = await offerRestore(io, opts);
	} catch {
		return { later: [] };
	}
	const [first, ...later] = accepted;
	if (!first) return { later: [] };
	if (hasControl(first.cwd)) {
		io.write(`  Its folder name could not be shown, so it resumed here, in ${safeLine(process.cwd(), 120)}.`);
		return { sessionResume: first.id, later };
	}
	try {
		process.chdir(first.cwd);
		return { sessionResume: first.id, later };
	} catch (e) {
		const why = (e as NodeJS.ErrnoException).code === "ENOENT" ? "it no longer exists" : "it cannot be opened";
		io.write(`  Could not open ${safeLine(first.cwd, 120)}: ${why}. Not resumed, and it is still listed for the next start.`);
		return { later };
	}
}

/** After the app has exited: show the reopen commands for later yeses, then forget them. */
export function finishRestore(later: RestorableSession[], write: (line: string) => void, opts: OpenOpts = {}): void {
	for (const s of later) write(`To reopen ${s.id}: ${reopenCommand(s)}`);
	const dir = opts.dir ?? defaultSessionsDir();
	const ids = new Set(later.map((s) => s.id));
	for (const { file, rec } of readRecords(dir)) {
		if (ids.has(rec.sessionId) && !isRunning(rec, opts.bootAt ?? currentBootAt())) {
			fs.rmSync(file, { force: true });
		}
	}
}
