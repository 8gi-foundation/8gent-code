/**
 * 8gent Session Writer
 *
 * Appends session entries to a JSONL file as the agent runs.
 * Designed for crash-safety: every entry is flushed immediately,
 * so even if the process dies the session file is valid up to
 * the last completed write.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type {
  SessionEntry,
  SessionMeta,
  Message,
  ToolCall,
  TokenUsage,
  HookExecution,
  SessionError,
  SessionSummary,
} from "./index.js";

const SESSIONS_DIR = path.join(os.homedir(), ".8gent", "sessions");

export class SessionWriter {
  private filePath: string;
  private fd: number;
  private seq: number = 0;
  private sessionId: string;
  private startTime: number;

  // Running counters for session_end summary
  private totalTurns = 0;
  private totalToolCalls = 0;
  private totalTokens = 0;
  private filesCreated: Set<string> = new Set();
  private filesModified: Set<string> = new Set();
  private filesDeleted: Set<string> = new Set();
  private gitCommits: string[] = [];

  constructor(sessionId: string, sessionsDir?: string) {
    this.sessionId = sessionId;
    this.startTime = Date.now();

    const dir = sessionsDir || SESSIONS_DIR;
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.filePath = path.join(dir, `${sessionId}.jsonl`);
    this.fd = fs.openSync(this.filePath, "a");
  }

  // ============================================
  // Core write
  // ============================================

  private write(entry: SessionEntry): void {
    const line = JSON.stringify(entry) + "\n";
    fs.writeSync(this.fd, line);
  }

  private nextSeq(): number {
    return this.seq++;
  }

  private now(): string {
    return new Date().toISOString();
  }

  // ============================================
  // Typed entry writers
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

  writeAssistantMessage(
    content: string,
    options?: {
      usage?: TokenUsage;
      turnIndex?: number;
      containsToolCalls?: boolean;
    }
  ): void {
    if (options?.usage?.totalTokens) {
      this.totalTokens += options.usage.totalTokens;
    }
    this.write({
      type: "assistant_message",
      timestamp: this.now(),
      sequenceNumber: this.nextSeq(),
      message: { role: "assistant", content },
      ...options,
    });
  }

  writeToolCall(toolCall: ToolCall, turnIndex?: number): void {
    this.totalToolCalls++;
    this.write({
      type: "tool_call",
      timestamp: this.now(),
      sequenceNumber: this.nextSeq(),
      toolCall,
      turnIndex,
    });
  }

  writeToolResult(
    toolCallId: string,
    success: boolean,
    result?: string,
    durationMs?: number
  ): void {
    this.write({
      type: "tool_result",
      timestamp: this.now(),
      sequenceNumber: this.nextSeq(),
      toolCallId,
      success,
      result,
      durationMs,
    });
  }

  writeTurnStart(turnIndex: number, messageCount?: number): void {
    this.totalTurns = Math.max(this.totalTurns, turnIndex + 1);
    this.write({
      type: "turn_start",
      timestamp: this.now(),
      sequenceNumber: this.nextSeq(),
      turnIndex,
      messageCount,
    });
  }

  writeTurnEnd(
    turnIndex: number,
    reason: "natural_stop" | "tool_calls" | "max_turns" | "error",
    usage?: TokenUsage
  ): void {
    if (usage?.totalTokens) {
      this.totalTokens += usage.totalTokens;
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

  writeSessionEnd(
    exitReason: SessionSummary["exitReason"],
    reportId?: string | null
  ): void {
    this.write({
      type: "session_end",
      timestamp: this.now(),
      sequenceNumber: this.nextSeq(),
      summary: {
        endedAt: this.now(),
        durationMs: Date.now() - this.startTime,
        totalTurns: this.totalTurns,
        totalToolCalls: this.totalToolCalls,
        totalTokens: this.totalTokens,
        filesCreated: Array.from(this.filesCreated),
        filesModified: Array.from(this.filesModified),
        filesDeleted: Array.from(this.filesDeleted),
        gitCommits: this.gitCommits,
        exitReason,
        reportId: reportId ?? null,
      },
    });

    fs.closeSync(this.fd);
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
}
