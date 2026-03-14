/**
 * 8gent Code - Core Types
 *
 * Shared type definitions for the agent harness.
 */

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Event emitted when a tool call starts */
export interface AgentToolStartEvent {
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
  stepNumber?: number;
}

/** Event emitted when a tool call finishes */
export interface AgentToolEndEvent {
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
  success: boolean;
  durationMs: number;
  stepNumber?: number;
  /** First ~200 chars of the result for display */
  resultPreview?: string;
}

/** Event emitted when a step finishes */
export interface AgentStepEvent {
  stepNumber: number;
  finishReason: string;
  text: string;
  toolCalls: Array<{ toolName: string; toolCallId: string }>;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}

/** Optional callbacks for real-time agent progress */
export interface AgentEventCallbacks {
  onToolStart?: (event: AgentToolStartEvent) => void;
  onToolEnd?: (event: AgentToolEndEvent) => void;
  onStepFinish?: (event: AgentStepEvent) => void;
}

export interface AgentConfig {
  model: string;
  runtime: "ollama" | "lmstudio" | "openrouter";
  systemPrompt?: string;
  maxTurns?: number;
  workingDirectory?: string;
  apiKey?: string;
  /** Real-time event callbacks for UI integration */
  events?: AgentEventCallbacks;
}

export interface LLMResponse {
  model: string;
  message: {
    role: string;
    content: string;
    tool_calls?: {
      function: {
        name: string;
        arguments: string;
      };
    }[];
  };
  done: boolean;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_eval_count?: number;
    eval_count?: number;
  };
}

/**
 * Common interface for all LLM clients
 */
export interface LLMClient {
  chat(messages: Message[], tools?: object[]): Promise<LLMResponse>;
  generate(prompt: string): Promise<string>;
  isAvailable(): Promise<boolean>;
}
