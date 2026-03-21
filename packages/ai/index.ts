/**
 * 8gent AI - Package Entry Point
 *
 * Wraps the Vercel AI SDK to provide the 8gent agent experience.
 * This package replaces the manual LLM client/tool loop in packages/eight
 * with the AI SDK's built-in agentic capabilities.
 *
 * Architecture:
 *   providers.ts        — Model factory using @ai-sdk/openai-compatible
 *   tools.ts            — All tools defined as AI SDK tool() objects
 *   agent.ts            — ToolLoopAgent wrapper with 8gent hooks
 *   toolshed-bridge.ts  — Registers AI SDK tools in the toolshed registry
 */

// Provider configuration
export { createModel, isProviderAvailable } from "./providers";
export type { ProviderName, ProviderConfig } from "./providers";

// Tools
export { agentTools, setToolContext, getToolContext } from "./tools";
export type { ToolContext, AgentTools } from "./tools";

// Agent
export { createEightAgent, runAgent } from "./agent";
export type {
  EightAgentConfig,
  StepFinishEvent,
  ToolCallStartEvent,
  ToolCallFinishEvent,
  FinishEvent,
} from "./agent";

// Task Router
export { TaskRouter, getTaskRouter, loadRouterConfig, saveRouterConfig, recordRouting, getRouterStats } from "./task-router";
export type { TaskCategory, RouteDecision, ModelSlot, RouterConfig } from "./task-router";

// Toolshed bridge
export { registerToolsInToolshed } from "./toolshed-bridge";

// Edge Inference - local embedding + classification, no API key required
export { embed, batchEmbed, similarity, classify, isEdgeInferenceAvailable } from "./edge-inference";
export { EmbeddingCache, getEmbeddingCache, cosineSimilarity } from "./embedding-cache";
