/**
 * Session journal and boot resume (#3552). Opt-in: EIGHT_RESUME_ON_BOOT=1.
 *
 * daemon-state.json is only written on a clean SIGTERM/SIGINT, so a power cut
 * or SIGKILL lost every open session. Instead, the pool journals each session
 * as it starts (and drops it when it ends), and on boot the daemon recreates
 * each journaled session and restores its newest time-travel checkpoint.
 *
 * Every journal write is tmp file + fsync + rename, so a crash leaves either
 * the old journal or the new one, never a torn file. The file is created
 * owner-only (0600) because entries carry tenant and user ids and the
 * session's system prompt. A failed write removes its tmp file.
 *
 * Entries are validated on read: anything that is not the expected shape,
 * or whose checkpoint id is not a plain id, is logged and dropped.
 *
 * Restore only puts the message history back. No tool call is run again:
 * whatever happened after the last checkpoint (up to EIGHT_CHECKPOINT_EVERY
 * tool calls) is lost, and the session waits for the user's next message.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { TimeTravelStore } from "../eight/timetravel/checkpoint-store";
import type { SessionOverrides } from "./agent-pool";

export interface JournalEntry {
	/** Pool session id (what clients resume with). */
	sessionId: string;
	channel: string;
	/** The agent's time-travel session id; checkpoints are stored under it. */
	ttSessionId: string;
	createdAt: number;
	/** createSession overrides, so scope/model/persona survive a restart. */
	overrides?: SessionOverrides;
}

/** Time-travel ids are joined into checkpoint paths, so only plain ids pass. */
const SAFE_TT_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

function isSafeTtId(v: unknown): v is string {
	return typeof v === "string" && SAFE_TT_ID.test(v) && !v.includes("..");
}

/** Pool session ids and channels are map keys and log fields, never paths. */
function isPlainKey(v: unknown): v is string {
	if (typeof v !== "string" || v.length === 0 || v.length > 256) return false;
	for (let i = 0; i < v.length; i++) {
		const c = v.charCodeAt(i);
		if (c < 0x20 || c === 0x7f) return false;
	}
	return true;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** True when `v` has the JournalEntry shape and safe ids. */
export function isValidJournalEntry(v: unknown): v is JournalEntry {
	if (!isPlainObject(v)) return false;
	return (
		isPlainKey(v.sessionId) &&
		isPlainKey(v.channel) &&
		isSafeTtId(v.ttSessionId) &&
		typeof v.createdAt === "number" &&
		Number.isFinite(v.createdAt) &&
		(v.overrides === undefined || isPlainObject(v.overrides))
	);
}

export function resumeOnBootEnabled(
	env: Record<string, string | undefined> = process.env,
): boolean {
	return env.EIGHT_RESUME_ON_BOOT === "1";
}

export class SessionJournal {
	constructor(readonly filePath: string) {}

	read(): JournalEntry[] {
		let raw: string;
		try {
			raw = fs.readFileSync(this.filePath, "utf8");
		} catch {
			return [];
		}
		try {
			const parsed = JSON.parse(raw);
			if (!Array.isArray(parsed?.sessions)) return [];
			const valid: JournalEntry[] = [];
			for (const e of parsed.sessions as unknown[]) {
				if (isValidJournalEntry(e)) valid.push(e);
				else
					console.error(`[session-journal] dropping malformed journal entry in ${this.filePath}`);
			}
			return valid;
		} catch {
			console.error(`[session-journal] unreadable journal at ${this.filePath}, starting empty`);
			return [];
		}
	}

	/** Add or replace the entry for entry.sessionId. */
	upsert(entry: JournalEntry): void {
		const sessions = this.read().filter((e) => e.sessionId !== entry.sessionId);
		sessions.push(entry);
		this.write(sessions);
	}

	remove(sessionId: string): void {
		const sessions = this.read();
		const kept = sessions.filter((e) => e.sessionId !== sessionId);
		if (kept.length !== sessions.length) this.write(kept);
	}

	private write(sessions: JournalEntry[]): void {
		const dir = path.dirname(this.filePath);
		fs.mkdirSync(dir, { recursive: true });
		const tmp = `${this.filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
		try {
			const fd = fs.openSync(tmp, "w", 0o600);
			try {
				fs.writeSync(fd, JSON.stringify({ version: 1, sessions }));
				fs.fsyncSync(fd);
			} finally {
				fs.closeSync(fd);
			}
			fs.renameSync(tmp, this.filePath);
		} catch (err) {
			try {
				fs.unlinkSync(tmp);
			} catch {}
			throw err;
		}
		// Persist the rename itself. Not supported on every platform; best effort.
		try {
			const dfd = fs.openSync(dir, "r");
			try {
				fs.fsyncSync(dfd);
			} finally {
				fs.closeSync(dfd);
			}
		} catch {}
	}
}

/** The slice of AgentPool the boot resume needs. */
export interface ResumePool {
	createSession(
		sessionId: string,
		channel: string,
		overrides?: SessionOverrides,
		options?: { journal?: boolean },
	): void;
	getAgent(sessionId: string): {
		adoptTimeTravelFork(sourceSessionId: string, checkpointId: string): { messages: unknown[] };
		getTimeTravelSessionId(): string;
	} | null;
}

export interface ResumeResult {
	sessionId: string;
	channel: string;
	/** Checkpoint restored from, or null when there was none (empty session). */
	checkpointId: string | null;
	messageCount: number;
	/** Tool calls the session had made at that checkpoint. */
	toolCallCount: number;
}

/**
 * Recreate every journaled session and restore its newest checkpoint. The
 * restore forks the old lineage into the new agent's, so the new agent holds
 * the restored state as its own first checkpoint and a second crash before
 * the next interval save still resumes. A session that cannot be restored
 * comes back empty; one bad entry never stops the rest.
 *
 * The journal entry is only moved to the new lineage once the restore has
 * succeeded (or there was nothing to restore). Until then it keeps naming
 * the old lineage, so a failed restore, or a crash during it, is retried on
 * the next start instead of losing the history that is still on disk.
 */
export function resumeJournaledSessions(
	journal: SessionJournal,
	pool: ResumePool,
	store: TimeTravelStore,
): ResumeResult[] {
	const results: ResumeResult[] = [];
	for (const entry of journal.read()) {
		const result: ResumeResult = {
			sessionId: entry.sessionId,
			channel: entry.channel,
			checkpointId: null,
			messageCount: 0,
			toolCallCount: 0,
		};
		try {
			pool.createSession(entry.sessionId, entry.channel, entry.overrides, { journal: false });
		} catch (err) {
			console.error(`[resume] could not recreate ${entry.sessionId}: ${String(err)}`);
			continue;
		}
		const agent = pool.getAgent(entry.sessionId);
		let restoredOrNothingToRestore = false;
		try {
			const latest = store.latest(entry.ttSessionId);
			if (latest && agent) {
				const { messages } = agent.adoptTimeTravelFork(entry.ttSessionId, latest.id);
				result.checkpointId = latest.id;
				result.messageCount = messages.length;
				result.toolCallCount = latest.toolCallCount;
			}
			restoredOrNothingToRestore = agent !== null;
		} catch (err) {
			console.error(
				`[resume] ${entry.sessionId}: checkpoint restore failed, session left empty; journal keeps the old checkpoint for the next start: ${String(err)}`,
			);
		}
		if (restoredOrNothingToRestore && agent) {
			try {
				journal.upsert({ ...entry, ttSessionId: agent.getTimeTravelSessionId() });
			} catch (err) {
				console.error(`[resume] ${entry.sessionId}: journal update failed: ${String(err)}`);
			}
		}
		console.log(
			result.checkpointId
				? `[resume] ${entry.sessionId} (channel=${entry.channel}) restored from ${result.checkpointId} at ${result.toolCallCount} tool calls, ${result.messageCount} messages; later work is not replayed`
				: `[resume] ${entry.sessionId} (channel=${entry.channel}) recreated with no checkpoint`,
		);
		results.push(result);
	}
	return results;
}
