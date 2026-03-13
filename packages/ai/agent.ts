/**
 * 8gent AI - Agent (AI SDK powered)
 *
 * Wraps the Vercel AI SDK ToolLoopAgent to provide the 8gent agent experience.
 * Replaces the manual agentic loop in packages/eight/agent.ts with the SDK's
 * built-in tool loop via generateText + stopWhen.
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
  stepType: string;
  text: string;
  toolCalls: Array<{ toolName: string; args: Record<string, unknown> }>;
  toolResults: Array<{ toolName: string; result: unknown }>;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  stepIndex: number;
}

export interface ToolCallStartEvent {
  toolName: string;
  args: Record<string, unknown>;
}

export interface ToolCallFinishEvent {
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
}

export interface FinishEvent {
  text: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  steps: StepFinishEvent[];
}

/**
 * Create an 8gent AI agent powered by the Vercel AI SDK.
 *
 * Usage:
 * ```ts
 * const agent = createEightAgent({
 *   provider: { name: "ollama", model: "qwen2.5-coder:7b" },
 *   instructions: "You are a coding assistant.",
 *   maxSteps: 30,
 *   workingDirectory: "/path/to/project",
 * });
 *
 * const result = await agent.generate({ prompt: "Fix the bug in main.ts" });
 * console.log(result.text);
 * ```
 */
export function createEightAgent(config: EightAgentConfig): ToolLoopAgent<never, AgentTools> {
  // Set the working directory for tool execution
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
            stepType: event.stepType ?? "unknown",
            text: event.text ?? "",
            toolCalls: (event.toolCalls ?? []).map((tc: any) => ({
              toolName: tc.toolName,
              args: tc.args,
            })),
            toolResults: (event.toolResults ?? []).map((tr: any) => ({
              toolName: tr.toolName,
              result: tr.result,
            })),
            usage: event.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            stepIndex: event.stepIndex ?? 0,
          };
          return config.onStepFinish!(stepEvent);
        }
      : undefined,

    experimental_onToolCallStart: config.onToolCallStart
      ? (event: any) => {
          return config.onToolCallStart!({
            toolName: event.toolName ?? event.toolCall?.toolName,
            args: event.args ?? event.toolCall?.args ?? {},
          });
        }
      : undefined,

    experimental_onToolCallFinish: config.onToolCallFinish
      ? (event: any) => {
          return config.onToolCallFinish!({
            toolName: event.toolName ?? event.toolCall?.toolName,
            args: event.args ?? event.toolCall?.args ?? {},
            result: event.result ?? event.toolResult?.result,
          });
        }
      : undefined,

    onFinish: config.onFinish
      ? (event: any) => {
          return config.onFinish!({
            text: event.text ?? "",
            usage: event.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            steps: (event.steps ?? []).map((s: any, i: number) => ({
              stepType: s.stepType ?? "unknown",
              text: s.text ?? "",
              toolCalls: s.toolCalls ?? [],
              toolResults: s.toolResults ?? [],
              usage: s.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
              stepIndex: i,
            })),
          });
        }
      : undefined,
  });

  return agent;
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
