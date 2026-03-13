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

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type {
  SessionEntry,
  SessionMeta,
  ToolCall,
  TokenUsage,
  DetailedTokenUsage,
  HookExecution,
  SessionError,
  SessionSummary,
  ContentPart,
  ModelInfo,
  ResponseMeta,
  FinishReason,
} from "./index.js";

const SESSIONS_DIR = path.join(os.homedir(), ".8gent", "sessions");

export class SessionWriter {
  private filePath: string;
  private fd: number;
  private seq: number = 0;
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
    this.write({
      type: "step_start",
      timestamp: this.now(),
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
    }
  ): void {
    this.totalSteps = Math.max(this.totalSteps, stepNumber + 1);
    if (options?.usage) {
      this.accumulateUsage(options.usage);
    }
    this.write({
      type: "step_end",
      timestamp: this.now(),
      sequenceNumber: this.nextSeq(),
      stepNumber,
      finishReason,
      usage: options?.usage,
      response: options?.response,
      providerMetadata: options?.providerMetadata,
    });
  }

  /** Write rich assistant content with typed parts (v2) */
  writeAssistantContent(
    stepNumber: number,
    parts: ContentPart[],
    usage?: DetailedTokenUsage
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
  writeToolError(
    toolCallId: string,
    toolName: string,
    error: string,
    stepNumber?: number
  ): void {
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
    stepNumber?: number
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
    }
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
    usage?: TokenUsage
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
      det.cacheReadTokens = (det.cacheReadTokens || 0) + (usage.inputTokenDetails.cacheReadTokens || 0);
      det.cacheWriteTokens = (det.cacheWriteTokens || 0) + (usage.inputTokenDetails.cacheWriteTokens || 0);
    }

    if (usage.outputTokenDetails) {
      if (!this.aggregatedUsage.outputTokenDetails) {
        this.aggregatedUsage.outputTokenDetails = {};
      }
      const det = this.aggregatedUsage.outputTokenDetails;
      det.textTokens = (det.textTokens || 0) + (usage.outputTokenDetails.textTokens || 0);
      det.reasoningTokens = (det.reasoningTokens || 0) + (usage.outputTokenDetails.reasoningTokens || 0);
    }
  }
}
