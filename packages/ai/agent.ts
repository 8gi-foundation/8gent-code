/**
 * 8gent AI - Agent (AI SDK powered)
 *
 * Wraps the Vercel AI SDK ToolLoopAgent to provide the 8gent agent experience.
 * Replaces the manual agentic loop in packages/eight/agent.ts with the SDK's
 * built-in tool loop via generateText + stopWhen.
 *
 * v2: Events now carry full AI SDK data (finishReason, reasoning, sources,
 * files, response metadata, provider metadata, detailed token usage).
 */

import { ToolLoopAgent, stepCountIs } from "ai";
import type { LanguageModel, GenerateTextResult, ToolSet } from "ai";
import { createModel, type ProviderConfig } from "./providers";
import { agentTools, setToolContext, type AgentTools } from "./tools";

export interface EightAgentConfig {
  /** Provider configuration */
  provider: ProviderConfig;
  /** System instructions */
  instructions?: string;
  /** Max steps (default: 30) */
  maxSteps?: number;
  /** Working directory */
  workingDirectory?: string;
  /** Tools to use (default: all agentTools) */
  tools?: ToolSet;
  /** Callback for each step */
  onStepFinish?: (event: StepFinishEvent) => void | Promise<void>;
  /** Callback for tool call start */
  onToolCallStart?: (event: ToolCallStartEvent) => void | Promise<void>;
  /** Callback for tool call finish */
  onToolCallFinish?: (event: ToolCallFinishEvent) => void | Promise<void>;
  /** Callback when generation finishes */
  onFinish?: (event: FinishEvent) => void | Promise<void>;
}

export interface StepFinishEvent {
  /** Step number (0-based) */
  stepNumber: number;
  /** Step type: "initial" or "tool-result" */
  stepType: string;
  /** Text generated in this step */
  text: string;
  /** Why this step finished (maps to AI SDK FinishReason) */
  finishReason: string;
  /** Raw finish reason from provider */
  rawFinishReason?: string;
  /** Reasoning/thinking content if model supports it */
  reasoning?: Array<{ type: string; text: string; signature?: string }>;
  /** Reasoning as flat text */
  reasoningText?: string;
  /** Sources/references used */
  sources?: Array<{ type: string; id: string; url?: string; title?: string }>;
  /** Generated files */
  files?: Array<{ mediaType: string; data: string }>;
  /** Tool calls made in this step */
  toolCalls: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>;
  /** Tool results from this step */
  toolResults: Array<{ toolCallId: string; toolName: string; result: unknown }>;
  /** Detailed token usage */
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    inputTokenDetails?: {
      noCacheTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
    outputTokenDetails?: {
      textTokens?: number;
      reasoningTokens?: number;
    };
    raw?: Record<string, unknown>;
  };
  /** Model info for this step */
  model?: { provider: string; modelId: string };
  /** Response metadata from provider */
  response?: {
    id?: string;
    timestamp?: string;
    modelId?: string;
    headers?: Record<string, string>;
  };
  /** Provider-specific pass-through metadata */
  providerMetadata?: Record<string, unknown>;
}

export interface ToolCallStartEvent {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  stepNumber?: number;
}

export interface ToolCallFinishEvent {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  success: boolean;
  result?: unknown;
  error?: unknown;
  durationMs: number;
  stepNumber?: number;
}

export interface FinishEvent {
  text: string;
  finishReason: string;
  usage: StepFinishEvent["usage"];
  totalUsage: StepFinishEvent["usage"];
  steps: StepFinishEvent[];
  response?: StepFinishEvent["response"];
}

/**
 * Create an 8gent AI agent powered by the Vercel AI SDK.
 */
export function createEightAgent(config: EightAgentConfig): ToolLoopAgent<never, AgentTools> {
  const workingDir = config.workingDirectory || process.cwd();
  setToolContext({ workingDirectory: workingDir });

  const model = createModel(config.provider);
  const tools = (config.tools as AgentTools) || agentTools;

  const agent = new ToolLoopAgent<never, AgentTools>({
    model,
    instructions: config.instructions,
    tools,
    stopWhen: stepCountIs(config.maxSteps || 30),

    onStepFinish: config.onStepFinish
      ? (event: any) => {
          const stepEvent: StepFinishEvent = {
            stepNumber: event.stepNumber ?? 0,
            stepType: event.stepType ?? "unknown",
            text: event.text ?? "",
            finishReason: event.finishReason ?? "other",
            rawFinishReason: event.rawFinishReason,
            reasoning: event.reasoning?.length
              ? event.reasoning.map((r: any) => ({
                  type: r.type ?? "reasoning",
                  text: r.text ?? "",
                  signature: r.signature,
                }))
              : undefined,
            reasoningText: event.reasoningText || undefined,
            sources: event.sources?.length
              ? event.sources.map((s: any) => ({
                  type: s.sourceType ?? s.type ?? "unknown",
                  id: s.id ?? "",
                  url: s.url,
                  title: s.title,
                }))
              : undefined,
            files: event.files?.length
              ? event.files.map((f: any) => ({
                  mediaType: f.mediaType ?? "application/octet-stream",
                  data: typeof f.base64 === "string" ? f.base64 : "",
                }))
              : undefined,
            toolCalls: (event.toolCalls ?? []).map((tc: any) => ({
              toolCallId: tc.toolCallId ?? "",
              toolName: tc.toolName ?? "",
              args: tc.args ?? tc.input ?? {},
            })),
            toolResults: (event.toolResults ?? []).map((tr: any) => ({
              toolCallId: tr.toolCallId ?? "",
              toolName: tr.toolName ?? "",
              result: tr.result ?? tr.output,
            })),
            usage: mapUsage(event.usage),
            model: event.model
              ? { provider: event.model.provider, modelId: event.model.modelId }
              : undefined,
            response: event.response
              ? {
                  id: event.response.id,
                  timestamp: event.response.timestamp
                    ? new Date(event.response.timestamp).toISOString()
                    : undefined,
                  modelId: event.response.modelId,
                  headers: event.response.headers,
                }
              : undefined,
            providerMetadata: event.providerMetadata || undefined,
          };
          return config.onStepFinish!(stepEvent);
        }
      : undefined,

    experimental_onToolCallStart: config.onToolCallStart
      ? (event: any) => {
          return config.onToolCallStart!({
            toolCallId: event.toolCall?.toolCallId ?? "",
            toolName: event.toolCall?.toolName ?? "",
            args: event.toolCall?.args ?? event.toolCall?.input ?? {},
            stepNumber: event.stepNumber,
          });
        }
      : undefined,

    experimental_onToolCallFinish: config.onToolCallFinish
      ? (event: any) => {
          return config.onToolCallFinish!({
            toolCallId: event.toolCall?.toolCallId ?? "",
            toolName: event.toolCall?.toolName ?? "",
            args: event.toolCall?.args ?? event.toolCall?.input ?? {},
            success: event.success ?? true,
            result: event.output,
            error: event.error,
            durationMs: event.durationMs ?? 0,
            stepNumber: event.stepNumber,
          });
        }
      : undefined,

    onFinish: config.onFinish
      ? (event: any) => {
          return config.onFinish!({
            text: event.text ?? "",
            finishReason: event.finishReason ?? "other",
            usage: mapUsage(event.usage),
            totalUsage: mapUsage(event.totalUsage ?? event.usage),
            steps: (event.steps ?? []).map((s: any, i: number) => ({
              stepNumber: s.stepNumber ?? i,
              stepType: s.stepType ?? "unknown",
              text: s.text ?? "",
              finishReason: s.finishReason ?? "other",
              toolCalls: s.toolCalls ?? [],
              toolResults: s.toolResults ?? [],
              usage: mapUsage(s.usage),
            })),
            response: event.response
              ? {
                  id: event.response.id,
                  timestamp: event.response.timestamp
                    ? new Date(event.response.timestamp).toISOString()
                    : undefined,
                  modelId: event.response.modelId,
                }
              : undefined,
          });
        }
      : undefined,
  });

  return agent;
}

/** Map AI SDK usage to our normalized format */
function mapUsage(usage: any): StepFinishEvent["usage"] {
  if (!usage) {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }
  return {
    promptTokens: usage.inputTokens ?? usage.promptTokens ?? 0,
    completionTokens: usage.outputTokens ?? usage.completionTokens ?? 0,
    totalTokens: usage.totalTokens ?? 0,
    inputTokenDetails: usage.inputTokenDetails
      ? {
          noCacheTokens: usage.inputTokenDetails.noCacheTokens,
          cacheReadTokens: usage.inputTokenDetails.cacheReadTokens,
          cacheWriteTokens: usage.inputTokenDetails.cacheWriteTokens,
        }
      : undefined,
    outputTokenDetails: usage.outputTokenDetails
      ? {
          textTokens: usage.outputTokenDetails.textTokens,
          reasoningTokens: usage.outputTokenDetails.reasoningTokens,
        }
      : undefined,
    raw: usage.raw,
  };
}

/**
 * Quick helper: run a single prompt through the agent and return the text result.
 */
export async function runAgent(
  config: EightAgentConfig,
  prompt: string
): Promise<{ text: string; steps: number; usage: { totalTokens: number } }> {
  const agent = createEightAgent(config);
  const result = await agent.generate({ prompt });

  return {
    text: result.text,
    steps: result.steps?.length ?? 0,
    usage: {
      totalTokens: result.usage?.totalTokens ?? 0,
    },
  };
}
