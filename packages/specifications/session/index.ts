/**
 * 8gent Session Specification v2
 *
 * TypeScript types for session persistence. These are the source of truth —
 * the agent writes JSONL files conforming to this spec, and the debugger reads them.
 *
 * v2 aligns with the Vercel AI SDK's data model:
 *   - "Steps" replace "turns" (1:1 with AI SDK StepResult)
 *   - Typed content parts (text, reasoning, source, file, tool-call, tool-result, tool-error)
 *   - Detailed token usage with cache/reasoning breakdowns
 *   - Per-step model info and finish reason
 *   - Response metadata and provider pass-through
 *
 * Storage: ~/.8gent/sessions/{sessionId}.jsonl
 * Format:  One JSON object per line (JSONL / JSON Lines)
 * Order:   First line is always session_start, last is session_end
 *
 * Backward compatibility: The reader handles both v1 and v2 sessions.
 * v1 entry types (turn_start, turn_end, assistant_message) are still parsed
 * but no longer emitted by the writer.
 */

// ============================================
// Core Primitives
// ============================================

export interface AgentInfo {
  /** Model identifier. e.g. 'openai/gpt-4.1-mini' */
  model: string;
  /** Which LLM backend served the model */
  runtime: "ollama" | "lmstudio" | "openrouter";
  /** Maximum agentic loop iterations (v1 vocabulary) */
  maxTurns?: number;
  /** Maximum steps (v2 vocabulary, maps to AI SDK stopWhen) */
  maxSteps?: number;
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
  /** Schema version. 1 = legacy turns, 2 = AI SDK steps */
  version: 1 | 2;
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

// ============================================
// v2: Finish Reasons (aligned with AI SDK)
// ============================================

/** Why a step finished. Maps directly to AI SDK's FinishReason. */
export type FinishReason =
  | "stop"            // Model generated stop sequence (natural completion)
  | "length"          // Hit max output tokens
  | "content-filter"  // Content filter stopped the model
  | "tool-calls"      // Model requested tool execution
  | "error"           // Model stopped due to error
  | "other";          // Unknown/other reason

// ============================================
// v2: Model Info (per-step, can change via prepareStep)
// ============================================

export interface ModelInfo {
  /** Provider name. e.g. 'ollama', 'openrouter' */
  provider: string;
  /** Model ID. e.g. 'qwen2.5-coder:7b', 'openai/gpt-4.1-mini' */
  modelId: string;
}

// ============================================
// v2: Detailed Token Usage
// ============================================

export interface DetailedTokenUsage {
  /** Total input (prompt) tokens */
  promptTokens?: number;
  /** Total output (completion) tokens */
  completionTokens?: number;
  /** Sum of prompt + completion tokens */
  totalTokens: number;
  /** Breakdown of input tokens by cache status */
  inputTokenDetails?: {
    /** Tokens not served from cache */
    noCacheTokens?: number;
    /** Tokens served from prompt cache (read) */
    cacheReadTokens?: number;
    /** Tokens written to prompt cache */
    cacheWriteTokens?: number;
  };
  /** Breakdown of output tokens by type */
  outputTokenDetails?: {
    /** Tokens used for text generation */
    textTokens?: number;
    /** Tokens used for reasoning/thinking */
    reasoningTokens?: number;
  };
  /** Raw usage object from the provider (pass-through) */
  raw?: Record<string, unknown>;
}

/** Simple token usage for backward compat with v1 */
export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens: number;
}

// ============================================
// v2: Response Metadata (per-step)
// ============================================

export interface ResponseMeta {
  /** Provider-assigned response ID */
  id?: string;
  /** ISO-8601 timestamp from the provider */
  timestamp?: string;
  /** Model ID as reported by the provider (may differ from request) */
  modelId?: string;
  /** Response headers (HTTP providers only) */
  headers?: Record<string, string>;
}

// ============================================
// v2: Content Parts (typed assistant output)
// ============================================

export interface TextPart {
  type: "text";
  text: string;
}

export interface ReasoningPart {
  type: "reasoning";
  text: string;
  /** Provider-specific reasoning signature for verification */
  signature?: string;
}

export interface SourcePart {
  type: "source";
  sourceType: string;
  id: string;
  url?: string;
  title?: string;
  providerMetadata?: Record<string, unknown>;
}

export interface FilePart {
  type: "file";
  /** IANA media type. e.g. 'image/png' */
  mediaType: string;
  /** Base64-encoded file data */
  data: string;
}

export interface ToolCallPart {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface ToolResultPart {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  result: unknown;
}

export interface ToolErrorPart {
  type: "tool-error";
  toolCallId: string;
  toolName: string;
  error: string;
}

export type ContentPart =
  | TextPart
  | ReasoningPart
  | SourcePart
  | FilePart
  | ToolCallPart
  | ToolResultPart
  | ToolErrorPart;

// ============================================
// v1: Legacy Tool Types (still parsed)
// ============================================

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

// ============================================
// Other Primitives
// ============================================

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
  /** v1: number of turns completed */
  totalTurns?: number;
  /** v2: number of steps completed */
  totalSteps?: number;
  totalToolCalls?: number;
  /** v1: flat total token count */
  totalTokens?: number;
  /** v2: aggregated detailed usage across all steps */
  totalUsage?: DetailedTokenUsage;
  filesCreated?: string[];
  filesModified?: string[];
  filesDeleted?: string[];
  gitCommits?: string[];
  exitReason: "user_exit" | "max_turns" | "max_steps" | "error" | "idle_timeout" | "completed";
  /** Link to the CompletionReport if one was generated */
  reportId?: string | null;
}

// ============================================
// Session Entries — v2 (new)
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

/** v2: Rich assistant output with typed content parts */
export interface AssistantContentEntry extends BaseEntry {
  type: "assistant_content";
  /** Step number (0-based) this content belongs to */
  stepNumber: number;
  /** Typed content parts produced in this step */
  parts: ContentPart[];
  /** Detailed token usage for this step */
  usage?: DetailedTokenUsage;
}

/** v2: Step boundary — start */
export interface StepStartEntry extends BaseEntry {
  type: "step_start";
  /** Step number (0-based) */
  stepNumber: number;
  /** Model used for this step (can change between steps via prepareStep) */
  model?: ModelInfo;
  /** Number of messages in context at step start */
  messageCount?: number;
}

/** v2: Step boundary — end */
export interface StepEndEntry extends BaseEntry {
  type: "step_end";
  /** Step number (0-based) */
  stepNumber: number;
  /** Why this step finished */
  finishReason: FinishReason;
  /** Detailed token usage for this step */
  usage?: DetailedTokenUsage;
  /** Provider response metadata */
  response?: ResponseMeta;
  /** Provider-specific pass-through metadata */
  providerMetadata?: Record<string, unknown>;
}

/** v2: Tool error (distinct from tool_result with success=false) */
export interface ToolErrorEntry extends BaseEntry {
  type: "tool_error";
  toolCallId: string;
  toolName: string;
  error: string;
  stepNumber?: number;
}

// ============================================
// Session Entries — v1 (legacy, still parsed)
// ============================================

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
  /** v2: step number for cross-referencing */
  stepNumber?: number;
}

export interface ToolResultEntry extends BaseEntry {
  type: "tool_result";
  toolCallId: string;
  result?: string;
  success: boolean;
  durationMs?: number;
  /** v2: tool name for easier querying */
  toolName?: string;
  /** v2: step number for cross-referencing */
  stepNumber?: number;
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

// ============================================
// Discriminated Union — all entry types
// ============================================

export type SessionEntry =
  // Both v1 and v2
  | SessionStartEntry
  | UserMessageEntry
  | ToolCallEntry
  | ToolResultEntry
  | HookEntry
  | ErrorEntry
  | SessionEndEntry
  // v2 only
  | AssistantContentEntry
  | StepStartEntry
  | StepEndEntry
  | ToolErrorEntry
  // v1 only (legacy, still parsed)
  | AssistantMessageEntry
  | TurnStartEntry
  | TurnEndEntry;

export type SessionEntryType = SessionEntry["type"];

// ============================================
// Re-exports
// ============================================

export { SessionWriter } from "./writer.js";
export { SessionReader, listSessions, type SessionListItem } from "./reader.js";

// Storage location
export const SESSIONS_DIR = ".8gent/sessions";
