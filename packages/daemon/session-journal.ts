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
 * Restore only puts the message history back. Whatever happened after the
 * last checkpoint (up to EIGHT_CHECKPOINT_EVERY tool calls) is lost, and the
 * session waits for the user's next message.
 *
 * Tool calls that were running when the daemon died (#3653) are journaled as
 * they start and dropped as they end. On boot, settleInterruptedToolCalls
 * re-runs only those whose replay class is "replay" (local reads). Every
 * other call is NOT run again: the model gets a harness note saying it was
 * not replayed and needs confirmation, so a write, command, push or message
 * is never silently repeated.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { TimeTravelStore } from "../eight/timetravel/checkpoint-store";
import { toolReplayClass } from "../eight/tools";
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
	/** Tool calls started and not yet ended (#3653). */
	inFlight?: InFlightToolCall[];
}

export interface InFlightToolCall {
	id: string;
	tool: string;
	/** Full args for a replayable call; a short summary for any other. */
	args: Record<string, unknown>;
	startedAt: number;
}

/** Longest string arg kept on disk for a call that is never replayed. */
const ARG_SUMMARY_CHARS = 200;

/**
 * What is journaled for a call. A replayable read keeps its args so it can be
 * re-run. Any other call keeps only short primitive values: enough for the
 * model to see what it was, without file contents or long commands on disk.
 */
export function journalArgs(tool: string, args: Record<string, unknown>): Record<string, unknown> {
	if (toolReplayClass(tool) === "replay") return args;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(args)) {
		if (typeof v === "string") {
			out[k] = v.length > ARG_SUMMARY_CHARS ? `${v.slice(0, ARG_SUMMARY_CHARS)}... (${v.length} chars)` : v;
		} else if (typeof v === "number" || typeof v === "boolean") {
			out[k] = v;
		}
	}
	return out;
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

function isValidInFlight(v: unknown): v is InFlightToolCall {
	return (
		isPlainObject(v) &&
		isPlainKey(v.id) &&
		isPlainKey(v.tool) &&
		isPlainObject(v.args) &&
		typeof v.startedAt === "number"
	);
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
		(v.overrides === undefined || isPlainObject(v.overrides)) &&
		(v.inFlight === undefined || Array.isArray(v.inFlight))
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
				if (isValidJournalEntry(e)) {
					// A malformed call is dropped; the session entry is kept.
					if (e.inFlight) e.inFlight = e.inFlight.filter(isValidInFlight);
					valid.push(e);
				} else
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

	/** Record a tool call as running. No-op for a session not journaled. */
	markToolStart(sessionId: string, call: InFlightToolCall): void {
		this.updateInFlight(sessionId, (calls) => [
			...calls.filter((c) => c.id !== call.id),
			{ ...call, args: journalArgs(call.tool, call.args) },
		]);
	}

	markToolEnd(sessionId: string, callId: string): void {
		this.updateInFlight(sessionId, (calls) => calls.filter((c) => c.id !== callId));
	}

	clearInFlight(sessionId: string): void {
		this.updateInFlight(sessionId, () => []);
	}

	private updateInFlight(
		sessionId: string,
		fn: (calls: InFlightToolCall[]) => InFlightToolCall[],
	): void {
		const sessions = this.read();
		const entry = sessions.find((e) => e.sessionId === sessionId);
		if (!entry) return;
		const before = entry.inFlight ?? [];
		const after = fn(before);
		if (before.length === 0 && after.length === 0) return;
		if (after.length > 0) entry.inFlight = after;
		else delete entry.inFlight;
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

/** The slice of AgentPool settling interrupted tool calls needs. */
export interface SettlePool {
	getAgent(sessionId: string): {
		runToolForResume(toolName: string, args: Record<string, unknown>): Promise<string>;
		addHarnessNote(body: string): void;
	} | null;
}

export interface SettleResult {
	sessionId: string;
	/** Call ids re-run because they were reads. */
	replayed: string[];
	/** Call ids not run again; the model was told to confirm them. */
	notReplayed: string[];
}

/** Longest re-run result put into the note. */
const REPLAY_RESULT_CHARS = 8000;

function describeCall(call: InFlightToolCall): string {
	return `${call.tool} ${JSON.stringify(call.args)}`;
}

/**
 * Run after resumeJournaledSessions (#3653). For each resumed session that
 * had tool calls running when the daemon died: re-run the reads, never the
 * rest, and tell the model which is which in one harness note. The journal's
 * in-flight list is cleared once the note is in, so a second crash does not
 * report the same calls again. A crash before that re-runs only the reads.
 */
export async function settleInterruptedToolCalls(
	journal: SessionJournal,
	pool: SettlePool,
): Promise<SettleResult[]> {
	const results: SettleResult[] = [];
	for (const entry of journal.read()) {
		const calls = entry.inFlight ?? [];
		if (calls.length === 0) continue;
		const agent = pool.getAgent(entry.sessionId);
		if (!agent) continue;
		const result: SettleResult = { sessionId: entry.sessionId, replayed: [], notReplayed: [] };
		const lines: string[] = [
			"[resume] The daemon stopped while these tool calls were running. It has restarted.",
		];
		for (const call of [...calls].sort((a, b) => a.startedAt - b.startedAt)) {
			const cls = toolReplayClass(call.tool);
			if (cls === "replay") {
				let output: string;
				try {
					output = await agent.runToolForResume(call.tool, call.args);
				} catch (err) {
					output = `[error] ${String(err)}`;
				}
				if (output.length > REPLAY_RESULT_CHARS) {
					output = `${output.slice(0, REPLAY_RESULT_CHARS)}\n... (truncated)`;
				}
				lines.push(`- ${describeCall(call)}: re-run (read only, safe to replay). Result:\n${output}`);
				result.replayed.push(call.id);
			} else {
				const why =
					cls === "never"
						? "It changes something (file, shell, git, network or a message)"
						: "Its replay class is unknown";
				lines.push(
					`- ${describeCall(call)}: not replayed, needs confirmation. ${why}, and it may or may not have taken effect. Check the current state and ask the user before doing it again.`,
				);
				result.notReplayed.push(call.id);
			}
		}
		agent.addHarnessNote(lines.join("\n"));
		try {
			journal.clearInFlight(entry.sessionId);
		} catch (err) {
			console.error(`[resume] ${entry.sessionId}: could not clear in-flight calls: ${String(err)}`);
		}
		console.log(
			`[resume] ${entry.sessionId}: ${result.replayed.length} interrupted read(s) re-run, ${result.notReplayed.length} call(s) not replayed, model told to confirm`,
		);
		results.push(result);
	}
	return results;
}
