/**
 * Durable turns, slice 1 (docs/specs/DURABLE-TURNS.md).
 *
 * An append-only ledger per session: an `intent` line before a tool runs and an
 * `effect` line after it finishes, each fsynced before the call goes on. A
 * process killed between the two (Termux killed by Android, a 4G drop that ends
 * the session) leaves an intent with no effect. On resume that call is reported
 * to the person instead of being replayed: a write may or may not have happened.
 *
 * The SessionWriter feeds this module (observeSessionEntry), so the native,
 * text-tool and run_batch loops are all covered without touching the loops.
 * Off unless `8gent --durable`, EIGHT_DURABLE=1 or /durable turned it on.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scrub } from "../../eight/secret-scanner.js";
import { type EffectCheck, buildSignature, effectCheck } from "./durable-verify.js";
import type { SessionEntry } from "./index.js";

export type LedgerRecord =
	/** A person's message started a turn. `msg` is their text, scrubbed and capped. */
	| { k: "turn"; at: string; msg?: string }
	/** A finished model step's text. Supersedes the `text` pieces streamed before it. */
	| { k: "step"; text: string; at: string }
	/** The turn finished (`done`), or the person closed it on resume (`skip`, `continue`). */
	| { k: "end"; how: "done" | "skip" | "continue"; at: string }
	| {
			k: "intent";
			id: string;
			tool: string;
			argsHash: string;
			/** Idempotency key: session and call id, stable across a retry check. */
			key: string;
			/** Path or command, so the person can see what to check. */
			hint?: string;
			/** Slice 3: the 8gent build that started the call. */
			build?: string;
			/** Slice 3: what resume checks to know the call already landed. */
			check?: EffectCheck;
			at: string;
	  }
	| { k: "effect"; id: string; ok: boolean; digest: string; at: string }
	| { k: "resolve"; id: string; how: "retry" | "skip" | "verified"; at: string };

export type IntentRecord = Extract<LedgerRecord, { k: "intent" }>;

let enabled = process.env.EIGHT_DURABLE === "1";
let sessionKey: string | null = null;

export function isDurableEnabled(): boolean {
	return enabled;
}
export function setDurableEnabled(on: boolean): void {
	enabled = on;
}
/** The session the ledger writes to: the id `8gent --resume` reopens. */
export function setDurableSession(key: string | null): void {
	flushText();
	sessionKey = key && /^[A-Za-z0-9._-]+$/.test(key) ? key : null;
}

export function ledgerPath(key: string): string {
	return path.join(
		process.env.HOME || os.homedir(),
		".8gent",
		"sessions",
		"durable",
		`${key}.jsonl`,
	);
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** Append one line and fsync it. Open per record: no long-lived fd to lose (#4774). */
export function appendRecord(key: string, rec: LedgerRecord): void {
	const file = ledgerPath(key);
	ownDir(path.dirname(file));
	const c = fs.constants;
	const fd = openOwnFile(file, c.O_WRONLY | c.O_APPEND | c.O_CREAT);
	try {
		fs.writeSync(fd, `${JSON.stringify(rec)}\n`);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Make the durable folder and refuse a symlink at `sessions` or `durable`: a
 * recursive mkdir follows a planted link, so each level is lstat-checked first.
 * The folder is ours and private, whatever made it first.
 */
function ownDir(dir: string): void {
	const sessions = path.dirname(dir);
	fs.mkdirSync(path.dirname(sessions), { recursive: true, mode: 0o700 });
	for (const d of [sessions, dir]) {
		// Checked before anything is created inside it: nothing is made through a link.
		const st = fs.lstatSync(d, { throwIfNoEntry: false });
		if (!st) fs.mkdirSync(d, { mode: 0o700 });
		else if (!st.isDirectory()) throw new Error(`${d} is not a directory (symlink refused)`);
	}
	fs.chmodSync(dir, 0o700);
}

/**
 * Open the ledger the way SessionWriter opens its log (#4774, #4776): O_NOFOLLOW so
 * a planted symlink cannot redirect it, a regular file only, and 0600 even on a
 * file that existed before. Opened per record, so no inode check is needed.
 */
function openOwnFile(file: string, flags: number): number {
	const fd = fs.openSync(file, flags | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
	try {
		const st = fs.fstatSync(fd);
		if (!st.isFile()) throw new Error(`${file} is not a regular file`);
		if ((st.mode & 0o777) !== 0o600 && flags & fs.constants.O_WRONLY) fs.fchmodSync(fd, 0o600);
		return fd;
	} catch (err) {
		fs.closeSync(fd);
		throw err;
	}
}

/**
 * What the person sees to identify the call. Secrets are scrubbed with the tool
 * runner's scanner, and query strings and URL credentials are dropped outright:
 * the hint is shown on resume and sent to the model by /durable retry.
 */
export function hintOf(args: Record<string, unknown> | undefined): string | undefined {
	const v = args?.path ?? args?.file_path ?? args?.command ?? args?.url;
	if (typeof v !== "string") return undefined;
	return scrub(v)
		.scrubbed.replace(/(\w+:\/\/)[^\s/@]+@/g, "$1")
		.replace(/(\w+:\/\/[^\s?"']*)\?[^\s"']*/g, "$1?...")
		.slice(0, 120);
}

/**
 * Called by SessionWriter for every entry it writes. A ledger failure is
 * reported once on stderr and never fails the turn.
 */
export function observeSessionEntry(entry: SessionEntry): void {
	if (!enabled || !sessionKey) return;
	const at = entry.timestamp;
	let rec: LedgerRecord | null = null;
	if (entry.type === "user_message") {
		rec = {
			k: "turn",
			at,
			msg: scrub(String(entry.message?.content ?? "")).scrubbed.slice(0, MSG_CAP),
		};
	} else if (entry.type === "assistant_content") {
		const text = (entry.parts ?? [])
			.map((p) => (p.type === "text" ? (p as { text: string }).text : ""))
			.join("");
		if (!text) return;
		// Model text can echo a key it read: scrubbed whole, before it reaches disk.
		rec = { k: "step", text: scrub(text).scrubbed.slice(0, TEXT_CAP), at };
	} else if (entry.type === "tool_call") {
		const tc = entry.toolCall;
		rec = {
			k: "intent",
			id: tc.toolCallId,
			tool: tc.name,
			argsHash: sha(JSON.stringify(tc.arguments ?? {})),
			key: `${sessionKey}:${tc.toolCallId}`,
			hint: hintOf(tc.arguments as Record<string, unknown>),
			build: buildSignature(),
			check: safeCheck(tc.name, tc.arguments as Record<string, unknown>),
			at,
		};
	} else if (entry.type === "tool_result")
		rec = {
			k: "effect",
			id: entry.toolCallId,
			ok: entry.success,
			digest: sha(entry.result ?? ""),
			at,
		};
	else if (entry.type === "tool_error")
		rec = { k: "effect", id: entry.toolCallId, ok: false, digest: sha(entry.error), at };
	if (!rec) return;
	safeAppend(rec);
}
let warned = false;

function safeAppend(rec: LedgerRecord): void {
	if (!sessionKey) return;
	try {
		record(sessionKey, rec);
	} catch (err) {
		if (!warned) console.error(`[durable] ledger not written: ${(err as Error).message}`);
		warned = true;
	}
}

/** Caps on what one turn keeps: the person's message and the reply text. */
const MSG_CAP = 4000;
const TEXT_CAP = 16000;
/** Streamed text is written at most this often, so a kill loses at most this window. */
export const TEXT_FLUSH_MS = 250;

/** The current turn folded from its records: what resume and the summary need. */
interface Fold {
	msg: string;
	at: string;
	partial: string;
	finished: TurnState["finished"];
	intents: Map<string, IntentRecord>;
	closed: Set<string>;
}

const join = (a: string, b: string) => (a && b ? `${a}\n\n${b}` : a || b);

function fold(f: Fold | null, r: LedgerRecord): Fold | null {
	if (r.k === "turn")
		return {
			msg: r.msg ?? "",
			at: r.at,
			partial: "",
			finished: [],
			intents: new Map(),
			closed: new Set(),
		};
	if (r.k === "end" || !f) return r.k === "end" ? null : f;
	if (r.k === "step") f.partial = join(f.partial, r.text).slice(-TEXT_CAP);
	else if (r.k === "intent") f.intents.set(r.id, r);
	else if (r.k === "effect") {
		f.closed.add(r.id);
		const i = f.intents.get(r.id);
		if (i) f.finished.push({ tool: i.tool, hint: i.hint, ok: r.ok });
	} else if (r.k === "resolve") f.closed.add(r.id);
	return f;
}

function toState(f: Fold, streamed: string): TurnState {
	return {
		msg: f.msg,
		partial: join(f.partial, streamed).slice(-TEXT_CAP),
		finished: [...f.finished],
		open: [...f.intents.values()].filter((i) => !f.closed.has(i.id)),
		at: f.at,
	};
}

function foldLedger(key: string): Fold | null {
	let f: Fold | null = null;
	for (const r of readLedger(key)) f = fold(f, r);
	return f;
}

/**
 * Per-session running state, so a boundary writes the summary from memory instead
 * of re-reading a ledger that grows with the session. Keyed by session, so two
 * tabs never share a stream buffer. Seeded from the ledger once per process.
 */
interface Live {
	turn: Fold | null;
	/** Raw streamed text of the step in flight. Scrubbed whole when written, never in pieces. */
	streamed: string;
	timer: ReturnType<typeof setTimeout> | null;
}
const live = new Map<string, Live>();

function liveFor(key: string): Live {
	let l = live.get(key);
	if (!l) {
		l = { turn: foldLedger(key), streamed: "", timer: null };
		live.set(key, l);
	}
	return l;
}

/** Append a record, fold it into the running turn, and rewrite the summary at a boundary. */
function record(key: string, rec: LedgerRecord): void {
	appendRecord(key, rec);
	const l = liveFor(key);
	l.turn = fold(l.turn, rec);
	if (rec.k === "turn" || rec.k === "step" || rec.k === "end") clearStream(l);
	if (rec.k !== "intent") writeTurnSummary(key);
}

function clearStream(l: Live): void {
	l.streamed = "";
	if (l.timer) clearTimeout(l.timer);
	l.timer = null;
}

/**
 * A piece of streamed reply text (slice 2). Called by the streamed-reply readers
 * in packages/ai/text-tool-endpoint.ts. Held in memory and written to the turn
 * summary (temp-then-rename) every TEXT_FLUSH_MS, scrubbed as one string so a key
 * split across chunks is still caught. Not appended to the ledger: the summary is
 * overwritten, so a long stream does not grow the ledger.
 */
export function noteStreamText(delta: string): void {
	if (!enabled || !sessionKey || !delta) return;
	const key = sessionKey;
	const l = liveFor(key);
	l.streamed = (l.streamed + delta).slice(-2 * TEXT_CAP);
	if (l.timer) return;
	l.timer = setTimeout(() => flushText(key), TEXT_FLUSH_MS);
	(l.timer as { unref?: () => void }).unref?.();
}

/** Write the streamed text now (a network error, a session switch, a test). */
export function flushText(key: string | null = sessionKey): void {
	if (!key) return;
	const l = live.get(key);
	if (!l) return;
	if (l.timer) clearTimeout(l.timer);
	l.timer = null;
	if (!l.streamed || !enabled) return;
	try {
		writeTurnSummary(key);
	} catch (err) {
		if (!warned) console.error(`[durable] summary not written: ${(err as Error).message}`);
		warned = true;
	}
}

/** The turn finished. Called when the turn loop returns a reply or the person stopped it. */
export function noteTurnEnd(): void {
	if (!enabled || !sessionKey) return;
	safeAppend({ k: "end", how: "done", at: new Date().toISOString() });
}

/** A check that cannot be computed leaves the call to the person; it never fails the turn. */
function safeCheck(tool: string, args: Record<string, unknown>): EffectCheck | undefined {
	try {
		return effectCheck(tool, args);
	} catch {
		return undefined;
	}
}

export function readLedger(key: string): LedgerRecord[] {
	let text: string;
	try {
		const fd = openOwnFile(ledgerPath(key), fs.constants.O_RDONLY);
		try {
			text = fs.readFileSync(fd, "utf8");
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return [];
	}
	const out: LedgerRecord[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line));
		} catch {
			// A torn last line from a kill mid-write: everything before it stands.
		}
	}
	return out;
}

/** Intents with no effect and no resolution: the calls a kill cut off. */
export function interruptedCalls(key: string): IntentRecord[] {
	const recs = readLedger(key);
	const closed = new Set(
		recs.filter((r) => r.k === "effect" || r.k === "resolve").map((r) => (r as { id: string }).id),
	);
	return recs.filter((r): r is IntentRecord => r.k === "intent" && !closed.has(r.id));
}

export interface ResumePlan {
	/** Read-only calls: safe to run again, nothing to ask. */
	rerunSafe: IntentRecord[];
	/** Calls that may have changed something: the person decides. Never replayed silently. */
	askPerson: IntentRecord[];
}

export function planResume(
	open: IntentRecord[],
	isReadOnly: (tool: string) => boolean,
): ResumePlan {
	return {
		rerunSafe: open.filter((c) => isReadOnly(c.tool)),
		askPerson: open.filter((c) => !isReadOnly(c.tool)),
	};
}

const label = (c: { tool: string; hint?: string }) => `${c.tool}${c.hint ? ` ${c.hint}` : ""}`;

/** What the person sees on resume, or null when the last turn finished cleanly. */
export function resumeNotice(plan: ResumePlan): string | null {
	if (plan.askPerson.length === 0 && plan.rerunSafe.length === 0) return null;
	const lines = ["The last turn was cut off mid-tool."];
	for (const c of plan.askPerson)
		lines.push(`  ${label(c)} (started ${c.at}): this may or may not have happened.`);
	for (const c of plan.rerunSafe) lines.push(`  ${label(c)}: read-only, safe to run again.`);
	lines.push("/durable retry: 8gent checks what is there, then redoes only what is missing.");
	lines.push("/durable skip: leave it as it is and carry on.");
	return lines.join("\n");
}

/** The prompt `/durable retry` sends: the ledger summary, not the raw history. */
export function retryPrompt(plan: ResumePlan): string {
	const all = [...plan.askPerson, ...plan.rerunSafe];
	return [
		"[durable] My last turn was interrupted before these tool calls recorded a result:",
		...all.map(
			(c) =>
				`- ${label(c)}${plan.askPerson.includes(c) ? " (may or may not have happened)" : " (read-only)"}`,
		),
		"Check the current state first (read the file, git status, list the output). Then redo only what is missing. Do not repeat a change that already landed.",
	].join("\n");
}

/** Close every open call so the next resume does not ask again. */
export function resolveInterrupted(key: string, how: "retry" | "skip"): number {
	const open = interruptedCalls(key);
	const at = new Date().toISOString();
	for (const c of open) appendRecord(key, { k: "resolve", id: c.id, how, at });
	return open.length;
}

export interface TurnState {
	/** The person's message that started the turn. */
	msg: string;
	/** Reply text written before the cut: finished steps plus streamed text after them. */
	partial: string;
	/** Tool calls that recorded a result. Never repeated on continue. */
	finished: { tool: string; hint?: string; ok: boolean }[];
	/** Tool calls with no result: may or may not have happened. */
	open: IntentRecord[];
	at: string;
}

/**
 * The last turn, or null when it ended. A turn with no `end` record was cut off:
 * killed while waiting on the model, a 4G drop mid-stream, the phone sleeping.
 */
export function lastTurn(key: string): TurnState | null {
	const f = foldLedger(key);
	if (!f) return null;
	// Text streamed after the last finished step lives only in the summary.
	let streamed = "";
	try {
		const sum = JSON.parse(fs.readFileSync(turnSummaryPath(key), "utf8"));
		if (sum?.open && sum.turn?.at === f.at && typeof sum.streamed === "string")
			streamed = sum.streamed;
	} catch {
		// No summary, or one from before this turn: the ledger alone stands.
	}
	return toState(f, streamed);
}

export function turnSummaryPath(key: string): string {
	return ledgerPath(key).replace(/\.jsonl$/, ".turn.json");
}

/**
 * The turn summary: the last turn's state as one JSON file, written to a temp
 * file and renamed over the target, so a kill mid-write leaves the old summary
 * or the new one, never half of either. Rewritten at every step, effect and end,
 * and every TEXT_FLUSH_MS while a reply streams. Built from memory, not the ledger.
 */
export function writeTurnSummary(key: string): void {
	const file = turnSummaryPath(key);
	ownDir(path.dirname(file));
	const l = liveFor(key);
	const streamed = l.turn && l.streamed ? scrub(l.streamed).scrubbed.slice(-TEXT_CAP) : "";
	const state = l.turn ? toState(l.turn, streamed) : null;
	const tmp = `${file}.${process.pid}.tmp`;
	const c = fs.constants;
	const fd = fs.openSync(tmp, c.O_WRONLY | c.O_CREAT | c.O_TRUNC | (c.O_NOFOLLOW ?? 0), 0o600);
	try {
		fs.writeSync(fd, JSON.stringify({ open: state !== null, turn: state, streamed }));
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	fs.renameSync(tmp, file);
}

/** What the person sees when the last turn stopped before it finished, or null. */
export function cutOffNotice(t: TurnState | null): string | null {
	if (!t) return null;
	const lines = ["The last turn stopped before it finished."];
	if (t.partial) lines.push(`What 8gent had written so far:\n${t.partial}`);
	if (t.finished.length > 0)
		lines.push(`Finished, will not run again: ${t.finished.map((f) => label(f)).join(", ")}.`);
	for (const c of t.open)
		lines.push(`Started, no result: ${label(c)}. 8gent checks it before redoing it.`);
	lines.push("/durable continue: continue where it stopped (the text above is kept).");
	lines.push("/durable skip: leave it and carry on.");
	return lines.join("\n");
}

/**
 * The prompt `/durable continue` sends: the person's request, the reply so far,
 * the tool calls that finished (not to be repeated), and any that may or may not
 * have happened. Built from the ledger, not the raw history.
 */
export function continuePrompt(t: TurnState, isReadOnly: (tool: string) => boolean): string {
	const out = ["[durable] My last turn was cut off before it finished. Continue where it stopped."];
	if (t.msg) out.push(`The request was:\n${t.msg}`);
	if (t.partial)
		out.push(`What you had written so far (keep it, do not start over):\n${t.partial}`);
	if (t.finished.length > 0) {
		out.push("These tool calls already finished. Do not run them again:");
		for (const f of t.finished) out.push(`- ${label(f)} (${f.ok ? "ok" : "failed"})`);
	}
	if (t.open.length > 0) {
		out.push("These started but recorded no result:");
		for (const c of t.open)
			out.push(
				`- ${label(c)}${isReadOnly(c.tool) ? " (read-only)" : " (may or may not have happened)"}`,
			);
		out.push("Check the current state first, then redo only what is missing.");
	}
	return out.join("\n");
}

/** Close the cut-off turn and its open calls, so the next resume asks nothing. */
export function closeTurn(key: string, how: "skip" | "continue"): void {
	resolveInterrupted(key, how === "skip" ? "skip" : "retry");
	record(key, { k: "end", how, at: new Date().toISOString() });
}

/**
 * A failure that cut the turn off rather than ending it: the connection dropped,
 * the stream went quiet, the host went away. Continue is offered for these; any
 * other error ends the turn.
 */
export function isCutOffError(err: unknown): boolean {
	const e = err as { name?: string; code?: string; message?: string } | null;
	const text = `${e?.name ?? ""} ${e?.code ?? ""} ${e?.message ?? String(err)}`;
	if (/AbortError|aborted by user|cancel/i.test(text)) return false;
	return /fetch failed|network|socket|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE|TurnTimeoutError|stream ended before|terminated|connection/i.test(
		text,
	);
}
