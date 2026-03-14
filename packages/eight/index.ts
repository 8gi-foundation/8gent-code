/**
 * 8gent Code - Agent Harness
 *
 * The engine that powers the 8gent autonomous coding agent.
 * This is the barrel export — all public API surfaces are re-exported from here.
 *
 * Architecture:
 *   types.ts     — Shared types (Message, ToolCall, AgentConfig, LLMResponse, LLMClient)
 *   prompt.ts    — Default system prompt
 *   clients/     — LLM client implementations (used for isAvailable() checks)
 *   tools.ts     — ToolExecutor (legacy tool execution, kept for REPL compatibility)
 *   agent.ts     — Agent class (powered by AI SDK via packages/ai)
 *   repl.ts      — CLI REPL with slash commands
 *
 * The agentic loop is now handled by the Vercel AI SDK's ToolLoopAgent.
 * See packages/ai/ for the AI SDK integration layer.
 */

// Types
export type {
  Message, ToolCall, AgentConfig, LLMResponse, LLMClient,
  AgentEventCallbacks, AgentToolStartEvent, AgentToolEndEvent, AgentStepEvent,
} from "./types";

// System prompt
export { DEFAULT_SYSTEM_PROMPT } from "./prompt";

// LLM Clients
export { OllamaClient, LMStudioClient, OpenRouterClient, createClient } from "./clients";

// Tool execution
export { ToolExecutor } from "./tools";

// Agent core
export { Agent } from "./agent";

// CLI REPL
export { startREPL } from "./repl";

// Context engineering (existing file)
export {
  estimateTokens,
  createContextWindow,
  updateContextWindow,
  hasContextRoom,
  getContextUsage,
  compressMessage,
  compressToolResult,
  createContextItem,
  prioritizeContext,
  selectContextItems,
  applyPriorityDecay,
  summarizeConversation,
  formatContextSummary,
  generateThinkingBlock,
  parseThinkingBlock,
} from "./context-engineering";

// ============================================
// CLI Entry Point
// ============================================

import { getPermissionManager } from "../permissions";
import type { AgentConfig } from "./types";
import { Agent } from "./agent";
import { startREPL } from "./repl";

if (import.meta.main) {
  let args = process.argv.slice(2);

  const hasInfiniteFlag = args.includes("--infinite") || args.includes("-infinite") || args.includes("-i");
  if (hasInfiniteFlag) {
    const permManager = getPermissionManager();
    permManager.enableInfiniteMode();
    args = args.filter(a => a !== "--infinite" && a !== "-infinite" && a !== "-i");
  }

  if (args.length > 0 && args[0] !== "--interactive") {
    const promptText = args.join(" ");
    (async () => {
      const config: AgentConfig = {
        model: process.env.EIGHGENT_MODEL || "glm-4.7-flash:latest",
        runtime: "ollama",
        workingDirectory: process.cwd(),
        maxTurns: hasInfiniteFlag ? 100 : 30,
      };
      const agent = new Agent(config);
      if (!(await agent.isReady())) {
        console.error("Ollama is not running");
        process.exit(1);
      }
      if (hasInfiniteFlag) {
        console.log(`\n∞ Infinite Loop mode enabled - Autonomous until done`);
      }
      console.log(`\n🎯 Task: ${promptText}\n`);
      try {
        const response = await agent.chat(promptText);
        console.log(`\n✅ Result:\n${response}`);
      } catch (err) {
        console.error(`❌ Error: ${err}`);
      }
      process.exit(0);
    })();
  } else if (args.length === 0 && hasInfiniteFlag) {
    console.log(`\n∞ Infinite Loop mode enabled - All permissions bypassed\n`);
    startREPL();
  } else {
    startREPL();
  }
}
