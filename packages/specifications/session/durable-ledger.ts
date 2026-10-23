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
import type { SessionEntry } from "./index.js";

export type LedgerRecord =
	| { k: "turn"; at: string }
	| {
			k: "intent";
			id: string;
			tool: string;
			argsHash: string;
			/** Idempotency key: session and call id, stable across a retry check. */
			key: string;
			/** Path or command, so the person can see what to check. */
			hint?: string;
			at: string;
	  }
	| { k: "effect"; id: string; ok: boolean; digest: string; at: string }
	| { k: "resolve"; id: string; how: "retry" | "skip"; at: string };

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
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const fd = fs.openSync(file, "a", 0o600);
	try {
		fs.writeSync(fd, `${JSON.stringify(rec)}\n`);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}

function hintOf(args: Record<string, unknown> | undefined): string | undefined {
	const v = args?.path ?? args?.file_path ?? args?.command ?? args?.url;
	return typeof v === "string" ? v.slice(0, 120) : undefined;
}

/**
 * Called by SessionWriter for every entry it writes. A ledger failure is
 * reported once on stderr and never fails the turn.
 */
export function observeSessionEntry(entry: SessionEntry): void {
	if (!enabled || !sessionKey) return;
	const at = entry.timestamp;
	let rec: LedgerRecord | null = null;
	if (entry.type === "user_message") rec = { k: "turn", at };
	else if (entry.type === "tool_call") {
		const tc = entry.toolCall;
		rec = {
			k: "intent",
			id: tc.toolCallId,
			tool: tc.name,
			argsHash: sha(JSON.stringify(tc.arguments ?? {})),
			key: `${sessionKey}:${tc.toolCallId}`,
			hint: hintOf(tc.arguments as Record<string, unknown>),
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
	try {
		appendRecord(sessionKey, rec);
	} catch (err) {
		if (!warned) console.error(`[durable] ledger not written: ${(err as Error).message}`);
		warned = true;
	}
}
let warned = false;

export function readLedger(key: string): LedgerRecord[] {
	let text: string;
	try {
		text = fs.readFileSync(ledgerPath(key), "utf8");
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

const label = (c: IntentRecord) => `${c.tool}${c.hint ? ` ${c.hint}` : ""}`;

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
