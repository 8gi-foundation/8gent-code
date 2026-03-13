/**
 * 8gent Session Specification
 *
 * TypeScript types generated from the session JSON Schema.
 * These types are the source of truth for session persistence —
 * the agent writes JSONL files conforming to this spec, and the
 * debugger app reads them.
 *
 * Storage: ~/.8gent/sessions/{sessionId}.jsonl
 * Format:  One JSON object per line (JSONL / JSON Lines)
 * Order:   First line is always session_start, last is session_end
 */

// ============================================
// Core Primitives
// ============================================

export interface AgentInfo {
  /** Model identifier. e.g. 'openai/gpt-4.1-mini' */
  model: string;
  /** Which LLM backend served the model */
  runtime: "ollama" | "lmstudio" | "openrouter";
  /** Maximum agentic loop iterations */
  maxTurns?: number;
  /** SHA-256 hash of the system prompt */
  systemPromptHash?: string;
}

export interface Environment {
  /** Absolute path of the project root */
  workingDirectory: string;
  /** Git branch at session start */
  gitBranch?: string | null;
  /** HEAD commit SHA at session start */
  gitCommit?: string | null;
  /** OS platform */
  platform?: "darwin" | "linux" | "win32";
  /** Node/Bun runtime version */
  nodeVersion?: string;
}

export interface SessionMeta {
  /** Unique session identifier. Format: session_{timestamp}_{random} */
  sessionId: string;
  /** Schema version for forward compatibility */
  version: 1;
  /** ISO-8601 timestamp when the session began */
  startedAt: string;
  /** Agent configuration */
  agent: AgentInfo;
  /** Execution environment snapshot */
  environment: Environment;
}

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ToolCall {
  /** Unique ID for this tool call within the session */
  toolCallId: string;
  /** Tool name. e.g. 'readFile', 'shellExec' */
  name: string;
  /** Arguments passed to the tool */
  arguments: Record<string, unknown>;
  /** Tool output */
  result?: string;
  /** Whether the tool executed without error */
  success: boolean;
  /** Error message if failed */
  error?: string | null;
  /** Wall-clock execution time in milliseconds */
  durationMs: number;
  startedAt?: string;
  completedAt?: string;
}

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens: number;
}

export interface HookExecution {
  hookName: string;
  hookType: "onStart" | "onComplete" | "onError" | "beforeTool" | "afterTool";
  durationMs?: number;
  success: boolean;
  error?: string | null;
}

export interface SessionError {
  message: string;
  code?: string | null;
  stack?: string | null;
  /** Whether the session continued after this error */
  recoverable: boolean;
}

export interface SessionSummary {
  endedAt: string;
  durationMs: number;
  totalTurns?: number;
  totalToolCalls?: number;
  totalTokens?: number;
  filesCreated?: string[];
  filesModified?: string[];
  filesDeleted?: string[];
  gitCommits?: string[];
  exitReason: "user_exit" | "max_turns" | "error" | "idle_timeout" | "completed";
  /** Link to the CompletionReport if one was generated */
  reportId?: string | null;
}

// ============================================
// Session Entry (discriminated union)
// ============================================

interface BaseEntry {
  timestamp: string;
  sequenceNumber: number;
}

export interface SessionStartEntry extends BaseEntry {
  type: "session_start";
  meta: SessionMeta;
}

export interface UserMessageEntry extends BaseEntry {
  type: "user_message";
  message: Message;
}

export interface AssistantMessageEntry extends BaseEntry {
  type: "assistant_message";
  message: Message;
  usage?: TokenUsage;
  turnIndex?: number;
  containsToolCalls?: boolean;
}

export interface ToolCallEntry extends BaseEntry {
  type: "tool_call";
  toolCall: ToolCall;
  turnIndex?: number;
}

export interface ToolResultEntry extends BaseEntry {
  type: "tool_result";
  toolCallId: string;
  result?: string;
  success: boolean;
  durationMs?: number;
}

export interface TurnStartEntry extends BaseEntry {
  type: "turn_start";
  turnIndex: number;
  messageCount?: number;
}

export interface TurnEndEntry extends BaseEntry {
  type: "turn_end";
  turnIndex: number;
  reason: "natural_stop" | "tool_calls" | "max_turns" | "error";
  usage?: TokenUsage;
}

export interface HookEntry extends BaseEntry {
  type: "hook";
  hook: HookExecution;
}

export interface ErrorEntry extends BaseEntry {
  type: "error";
  error: SessionError;
}

export interface SessionEndEntry extends BaseEntry {
  type: "session_end";
  summary: SessionSummary;
}

export type SessionEntry =
  | SessionStartEntry
  | UserMessageEntry
  | AssistantMessageEntry
  | ToolCallEntry
  | ToolResultEntry
  | TurnStartEntry
  | TurnEndEntry
  | HookEntry
  | ErrorEntry
  | SessionEndEntry;

export type SessionEntryType = SessionEntry["type"];

// ============================================
// Session Writer (for the agent to use)
// ============================================

export { SessionWriter } from "./writer.js";
export { SessionReader, listSessions, type SessionListItem } from "./reader.js";

// Storage location
export const SESSIONS_DIR = ".8gent/sessions";
