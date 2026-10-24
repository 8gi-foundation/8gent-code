/**
 * 8gent Session Writer v2
 *
 * Appends session entries to a JSONL file as the agent runs.
 * Designed for crash-safety: every entry is flushed immediately,
 * so even if the process dies the session file is valid up to
 * the last completed write.
 *
 * v2 emits step_start/step_end/assistant_content instead of
 * turn_start/turn_end/assistant_message. The v1 methods are kept
 * as deprecated wrappers for backward compatibility.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { observeSessionEntry } from "./durable-ledger.js";
import type {
	ContentPart,
	DetailedTokenUsage,
	FinishReason,
	FrictionEntry,
	HookExecution,
	ModelInfo,
	ModelRoundEntry,
	ResponseMeta,
	SessionEntry,
	SessionError,
	SessionMeta,
	SessionSummary,
	TokenUsage,
	ToolCall,
} from "./index.js";

// Resolved at call time: Bun's os.homedir() ignores a runtime HOME change (#3678).
function defaultSessionsDir(): string {
	return path.join(process.env.HOME || os.homedir(), ".8gent", "sessions");
}

export class SessionWriter {
	private filePath: string;
	private fd = -1;
	/** Device and inode of the file `fd` was opened on; a mismatch means the number now names another file. */
	private dev = -1;
	private ino = -1;
	/** False for a session that must leave nothing on disk (classroom, #3939). */
	private persist: boolean;
	private seq = 0;
	private sessionId: string;
	private startTime: number;

	// Running counters for session_end summary
	private totalSteps = 0;
	private totalToolCalls = 0;
	private filesCreated: Set<string> = new Set();
	private filesModified: Set<string> = new Set();
	private filesDeleted: Set<string> = new Set();
	private gitCommits: string[] = [];

	// v2: Aggregated token usage across all steps
	private aggregatedUsage: DetailedTokenUsage = {
		promptTokens: 0,
		completionTokens: 0,
		totalTokens: 0,
	};

	/** Epoch-ms clock; injectable so tests can prove duration = end - start. */
	private clock: () => number;

	constructor(
		sessionId: string,
		sessionsDir?: string,
		clock: () => number = Date.now,
		persist = true,
	) {
		this.clock = clock;
		this.persist = persist;
		this.sessionId = sessionId;
		this.startTime = Date.now();

		const dir = sessionsDir || defaultSessionsDir();
		if (!persist) {
			this.filePath = path.join(dir, `${sessionId}.jsonl`);
			this.fd = -1;
			return;
		}
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}

		this.filePath = path.join(dir, `${sessionId}.jsonl`);
		this.open();
	}

	private open(): void {
		// O_NOFOLLOW: a session path swapped for a symlink must not redirect the log
		// into another file (reopen happens mid-session, #4774). Absent on Windows.
		const c = fs.constants;
		const fd = fs.openSync(
			this.filePath,
			c.O_WRONLY | c.O_APPEND | c.O_CREAT | (c.O_NOFOLLOW ?? 0),
			0o600,
		);
		const st = fs.fstatSync(fd);
		if (!st.isFile()) {
			fs.closeSync(fd);
			throw new Error(`${this.filePath} is not a regular file`);
		}
		this.fd = fd;
		this.dev = st.dev;
		this.ino = st.ino;
	}

	/**
	 * True while `fd` is still open on our session file. A long session can lose it
	 * (closed under a multiplexer, or the number closed and reused by other code):
	 * writing to it then threw EBADF out of every later turn (#4774), or landed
	 * session lines in someone else's file.
	 */
	private fdIsOurs(): boolean {
		if (this.fd < 0) return false;
		try {
			const st = fs.fstatSync(this.fd);
			return st.dev === this.dev && st.ino === this.ino;
		} catch {
			return false;
		}
	}

	// ============================================
	// Core write
	// ============================================

	private write(entry: SessionEntry): void {
		if (!this.persist) return;
		// Durable turns (docs/specs/DURABLE-TURNS.md): intent before a tool runs, effect after.
		observeSessionEntry(entry);
		const line = `${JSON.stringify(entry)}\n`;
		// The session log is a record, never a reason to fail a turn (#4774): a lost
		// fd is reopened by path; if the file cannot be written at all, the line is skipped.
		try {
			if (!this.fdIsOurs()) this.open();
			fs.writeSync(this.fd, line);
		} catch (err) {
			this.fd = -1;
			this.skippedWrites++;
			this.lastWriteError = `session log not written: ${err instanceof Error ? err.message : String(err)}`;
		}
	}

	/** The one-line note for the last session-log write that was skipped, or null. */
	lastWriteError: string | null = null;
	/** How many session-log lines were skipped, so a gap in the log is never silent. */
	skippedWrites = 0;

	private nextSeq(): number {
		return this.seq++;
	}

	private now(): string {
		return new Date(this.clock()).toISOString();
	}

	/** Epoch ms at which each open step began, keyed by step number. */
	private stepStartedAt = new Map<number, number>();

	// ============================================
	// Session lifecycle
	// ============================================

	writeSessionStart(meta: SessionMeta): void {
		this.write({
			type: "session_start",
			timestamp: this.now(),
			sequenceNumber: this.nextSeq(),
			meta,
		});
	}

	writeUserMessage(content: string): void {
		this.write({
			type: "user_message",
			timestamp: this.now(),
			sequenceNumber: this.nextSeq(),
			message: { role: "user", content },
		});
	}

	// ============================================
	// v2: Step-based entries
	// ============================================

	/** Write step start boundary (v2) */
	writeStepStart(stepNumber: number, model?: ModelInfo, messageCount?: number): void {
		this.totalSteps = Math.max(this.totalSteps, stepNumber + 1);
		const at = this.clock();
		this.stepStartedAt.set(stepNumber, at);
		this.write({
			type: "step_start",
			timestamp: new Date(at).toISOString(),
			sequenceNumber: this.nextSeq(),
			stepNumber,
			model,
			messageCount,
		});
	}

	/** Write step end boundary with AI SDK finish reason and detailed usage (v2) */
	writeStepEnd(
		stepNumber: number,
		finishReason: FinishReason,
		options?: {
			usage?: DetailedTokenUsage;
			response?: ResponseMeta;
			providerMetadata?: Record<string, unknown>;
		},
	): void {
		this.totalSteps = Math.max(this.totalSteps, stepNumber + 1);
		if (options?.usage) {
			this.accumulateUsage(options.usage);
		}
		const at = this.clock();
		const startedAt = this.stepStartedAt.get(stepNumber);
		this.stepStartedAt.delete(stepNumber);
		this.write({
			type: "step_end",
			timestamp: new Date(at).toISOString(),
			sequenceNumber: this.nextSeq(),
			stepNumber,
			finishReason,
			// Wall time from step_start to step_end; absent when no start was seen.
			durationMs: startedAt === undefined ? undefined : at - startedAt,
			usage: options?.usage,
			response: options?.response,
			providerMetadata: options?.providerMetadata,
		});
	}

	private modelRounds = 0;

	/** Prefill meter (#3655): one line per model request, numbered per session. */
	writeModelRound(
		r: Omit<ModelRoundEntry, "type" | "timestamp" | "sequenceNumber" | "round">,
	): void {
		this.write({
			type: "model_round",
			timestamp: this.now(),
			sequenceNumber: this.nextSeq(),
			round: this.modelRounds++,
			...r,
		});
	}

	/** Write rich assistant content with typed parts (v2) */
	writeAssistantContent(
		stepNumber: number,
		parts: ContentPart[],
		usage?: DetailedTokenUsage,
	): void {
		if (usage) {
			this.accumulateUsage(usage);
		}
		this.write({
			type: "assistant_content",
			timestamp: this.now(),
			sequenceNumber: this.nextSeq(),
			stepNumber,
			parts,
			usage,
		});
	}

	/** Write a tool error entry (v2) — distinct from tool_result with success=false */
	writeToolError(toolCallId: string, toolName: string, error: string, stepNumber?: number): void {
		this.write({
			type: "tool_error",
			timestamp: this.now(),
			sequenceNumber: this.nextSeq(),
			toolCallId,
			toolName,
			error,
			stepNumber,
		});
	}

	// ============================================
	// Shared entries (both v1 and v2)
	// ============================================

	writeToolCall(toolCall: ToolCall, turnIndex?: number, stepNumber?: number): void {
		this.totalToolCalls++;
		this.write({
			type: "tool_call",
			timestamp: this.now(),
			sequenceNumber: this.nextSeq(),
			toolCall,
			turnIndex,
			stepNumber,
		});
	}

	writeToolResult(
		toolCallId: string,
		success: boolean,
		result?: string,
		durationMs?: number,
		toolName?: string,
		stepNumber?: number,
	): void {
		this.write({
			type: "tool_result",
			timestamp: this.now(),
			sequenceNumber: this.nextSeq(),
			toolCallId,
			success,
			result,
			durationMs,
			toolName,
			stepNumber,
		});
	}

	writeHook(hook: HookExecution): void {
		this.write({
			type: "hook",
			timestamp: this.now(),
			sequenceNumber: this.nextSeq(),
			hook,
		});
	}

	writeError(error: SessionError): void {
		this.write({
			type: "error",
			timestamp: this.now(),
			sequenceNumber: this.nextSeq(),
			error,
		});
	}

	// ============================================
	// v1: Legacy methods (deprecated, kept for compat)
	// ============================================

	/** @deprecated Use writeAssistantContent for v2 sessions */
	writeAssistantMessage(
		content: string,
		options?: {
			usage?: TokenUsage;
			turnIndex?: number;
			containsToolCalls?: boolean;
		},
	): void {
		if (options?.usage?.totalTokens) {
			this.accumulateUsage({
				promptTokens: options.usage.promptTokens,
				completionTokens: options.usage.completionTokens,
				totalTokens: options.usage.totalTokens,
			});
		}
		this.write({
			type: "assistant_message",
			timestamp: this.now(),
			sequenceNumber: this.nextSeq(),
			message: { role: "assistant", content },
			...options,
		});
	}

	/** @deprecated Use writeStepStart for v2 sessions */
	writeTurnStart(turnIndex: number, messageCount?: number): void {
		this.totalSteps = Math.max(this.totalSteps, turnIndex + 1);
		this.write({
			type: "turn_start",
			timestamp: this.now(),
			sequenceNumber: this.nextSeq(),
			turnIndex,
			messageCount,
		});
	}

	/** @deprecated Use writeStepEnd for v2 sessions */
	writeTurnEnd(
		turnIndex: number,
		reason: "natural_stop" | "tool_calls" | "max_turns" | "error",
		usage?: TokenUsage,
	): void {
		if (usage?.totalTokens) {
			this.accumulateUsage({
				promptTokens: usage.promptTokens,
				completionTokens: usage.completionTokens,
				totalTokens: usage.totalTokens,
			});
		}
		this.write({
			type: "turn_end",
			timestamp: this.now(),
			sequenceNumber: this.nextSeq(),
			turnIndex,
			reason,
			usage,
		});
	}

	// ============================================
	// File tracking (called by tool executor)
	// ============================================

	trackFileCreated(filePath: string): void {
		this.filesCreated.add(filePath);
	}

	trackFileModified(filePath: string): void {
		this.filesModified.add(filePath);
	}

	trackFileDeleted(filePath: string): void {
		this.filesDeleted.add(filePath);
	}

	trackGitCommit(sha: string): void {
		this.gitCommits.push(sha);
	}

	// ============================================
	// Session end
	// ============================================

	/** One counts-only friction line at session end (#4511); written before session_end. */
	writeFriction(record: Omit<FrictionEntry, "timestamp" | "sequenceNumber">): void {
		this.write({ ...record, timestamp: this.now(), sequenceNumber: this.nextSeq() });
	}

	writeSessionEnd(
		exitReason: SessionSummary["exitReason"],
		reportId?: string | null,
		readCardsShown?: number,
	): void {
		this.write({
			type: "session_end",
			timestamp: this.now(),
			sequenceNumber: this.nextSeq(),
			summary: {
				endedAt: this.now(),
				durationMs: Date.now() - this.startTime,
				totalSteps: this.totalSteps,
				totalTurns: this.totalSteps, // backward compat alias
				totalToolCalls: this.totalToolCalls,
				totalTokens: this.aggregatedUsage.totalTokens,
				totalUsage: this.aggregatedUsage,
				filesCreated: Array.from(this.filesCreated),
				filesModified: Array.from(this.filesModified),
				filesDeleted: Array.from(this.filesDeleted),
				gitCommits: this.gitCommits,
				exitReason,
				reportId: reportId ?? null,
				...(readCardsShown === undefined ? {} : { read_cards_shown: readCardsShown }),
			},
		});

		if (this.persist && this.fdIsOurs()) fs.closeSync(this.fd);
		this.fd = -1;
	}

	// ============================================
	// Getters
	// ============================================

	getFilePath(): string {
		return this.filePath;
	}

	getSessionId(): string {
		return this.sessionId;
	}

	getFilesCreated(): Set<string> {
		return this.filesCreated;
	}

	getFilesModified(): Set<string> {
		return this.filesModified;
	}

	// ============================================
	// Internal helpers
	// ============================================

	private accumulateUsage(usage: DetailedTokenUsage): void {
		this.aggregatedUsage.totalTokens += usage.totalTokens || 0;
		this.aggregatedUsage.promptTokens =
			(this.aggregatedUsage.promptTokens || 0) + (usage.promptTokens || 0);
		this.aggregatedUsage.completionTokens =
			(this.aggregatedUsage.completionTokens || 0) + (usage.completionTokens || 0);

		// Accumulate detailed breakdowns
		if (usage.inputTokenDetails) {
			if (!this.aggregatedUsage.inputTokenDetails) {
				this.aggregatedUsage.inputTokenDetails = {};
			}
			const det = this.aggregatedUsage.inputTokenDetails;
			det.noCacheTokens = (det.noCacheTokens || 0) + (usage.inputTokenDetails.noCacheTokens || 0);
			det.cacheReadTokens =
				(det.cacheReadTokens || 0) + (usage.inputTokenDetails.cacheReadTokens || 0);
			det.cacheWriteTokens =
				(det.cacheWriteTokens || 0) + (usage.inputTokenDetails.cacheWriteTokens || 0);
		}

		if (usage.outputTokenDetails) {
			if (!this.aggregatedUsage.outputTokenDetails) {
				this.aggregatedUsage.outputTokenDetails = {};
			}
			const det = this.aggregatedUsage.outputTokenDetails;
			det.textTokens = (det.textTokens || 0) + (usage.outputTokenDetails.textTokens || 0);
			det.reasoningTokens =
				(det.reasoningTokens || 0) + (usage.outputTokenDetails.reasoningTokens || 0);
		}
	}
}
