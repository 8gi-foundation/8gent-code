/**
 * Session journal and boot resume (#3552). Opt-in: EIGHT_RESUME_ON_BOOT=1.
 *
 * daemon-state.json is only written on a clean SIGTERM/SIGINT, so a power cut
 * or SIGKILL lost every open session. Instead, the pool journals each session
 * as it starts (and drops it when it ends), and on boot the daemon recreates
 * each journaled session and restores its newest time-travel checkpoint.
 *
 * Every journal write is tmp file + fsync + rename, so a crash leaves either
 * the old journal or the new one, never a torn file.
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

export function resumeOnBootEnabled(env: Record<string, string | undefined> = process.env): boolean {
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
			return Array.isArray(parsed?.sessions) ? parsed.sessions : [];
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
		const fd = fs.openSync(tmp, "w");
		try {
			fs.writeSync(fd, JSON.stringify({ version: 1, sessions }));
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		fs.renameSync(tmp, this.filePath);
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
	createSession(sessionId: string, channel: string, overrides?: SessionOverrides): void;
	getAgent(sessionId: string): {
		adoptTimeTravelFork(sourceSessionId: string, checkpointId: string): { messages: unknown[] };
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
			pool.createSession(entry.sessionId, entry.channel, entry.overrides);
		} catch (err) {
			console.error(`[resume] could not recreate ${entry.sessionId}: ${String(err)}`);
			continue;
		}
		try {
			const latest = store.latest(entry.ttSessionId);
			const agent = pool.getAgent(entry.sessionId);
			if (latest && agent) {
				const { messages } = agent.adoptTimeTravelFork(entry.ttSessionId, latest.id);
				result.checkpointId = latest.id;
				result.messageCount = messages.length;
				result.toolCallCount = latest.toolCallCount;
			}
		} catch (err) {
			console.error(`[resume] ${entry.sessionId}: checkpoint restore failed, session left empty: ${String(err)}`);
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
