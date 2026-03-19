/**
 * ContextManager — Context isolation and sharing between orchestrated agents.
 *
 * Each agent has its own context window. The orchestrator decides what to share.
 * Three policies:
 *   - full: sees everything (orchestrator Eight only)
 *   - task_only: sees delegated task + relevant file context
 *   - summary: gets compressed summary of other agents' work
 */

export type ContextPolicy = "full" | "task_only" | "summary";

export interface ContextSlice {
  /** Messages relevant to this agent */
  messages: Array<{ role: string; content: string }>;
  /** System context (task description, relevant files) */
  systemContext: string;
  /** Estimated token count */
  estimatedTokens: number;
}

interface AgentContext {
  agentId: string;
  policy: ContextPolicy;
  messages: Array<{ role: string; content: string }>;
  taskDescription: string;
  maxTokens: number;
}

export class ContextManager {
  private contexts: Map<string, AgentContext> = new Map();
  private globalHistory: Array<{ role: string; content: string; agentId: string; timestamp: number }> = [];

  /**
   * Register an agent's context with a specific policy.
   */
  registerAgent(
    agentId: string,
    policy: ContextPolicy,
    taskDescription: string,
    maxTokens = 4096
  ): void {
    this.contexts.set(agentId, {
      agentId,
      policy,
      messages: [],
      taskDescription,
      maxTokens,
    });
  }

  /**
   * Remove an agent's context.
   */
  unregisterAgent(agentId: string): void {
    this.contexts.delete(agentId);
  }

  /**
   * Add a message to the global history and route to relevant agents.
   */
  addMessage(
    role: string,
    content: string,
    fromAgentId: string,
    targetAgentId?: string
  ): void {
    const entry = {
      role,
      content,
      agentId: fromAgentId,
      timestamp: Date.now(),
    };

    this.globalHistory.push(entry);

    // Trim global history to last 200 messages
    if (this.globalHistory.length > 200) {
      this.globalHistory = this.globalHistory.slice(-200);
    }

    // Route to target agent if specified
    if (targetAgentId) {
      const ctx = this.contexts.get(targetAgentId);
      if (ctx) {
        ctx.messages.push({ role, content });
        this.trimMessages(ctx);
      }
      return;
    }

    // Otherwise distribute based on policy
    for (const ctx of this.contexts.values()) {
      if (ctx.agentId === fromAgentId) {
        // Always include own messages
        ctx.messages.push({ role, content });
        this.trimMessages(ctx);
      } else if (ctx.policy === "full") {
        // Full policy: include everything
        ctx.messages.push({ role, content: `[${fromAgentId}] ${content}` });
        this.trimMessages(ctx);
      }
      // task_only and summary policies don't get routed messages automatically
    }
  }

  /**
   * Get the context slice for a specific agent.
   * This is what gets injected into the agent's system prompt or message history.
   */
  getContextSlice(agentId: string): ContextSlice {
    const ctx = this.contexts.get(agentId);
    if (!ctx) {
      return { messages: [], systemContext: "", estimatedTokens: 0 };
    }

    let systemContext = `Task: ${ctx.taskDescription}`;

    if (ctx.policy === "summary") {
      // Generate compressed summary of other agents' activity
      const otherAgents = Array.from(this.contexts.values())
        .filter(c => c.agentId !== agentId);

      if (otherAgents.length > 0) {
        const summaries = otherAgents.map(other => {
          const recentMessages = other.messages.slice(-3);
          const lastMsg = recentMessages[recentMessages.length - 1];
          return `${other.agentId}: working on "${other.taskDescription}"${lastMsg ? ` (latest: ${lastMsg.content.slice(0, 80)}...)` : ""}`;
        });
        systemContext += "\n\nOther agents:\n" + summaries.join("\n");
      }
    }

    const estimatedTokens = this.estimateTokens(ctx.messages, systemContext);

    return {
      messages: [...ctx.messages],
      systemContext,
      estimatedTokens,
    };
  }

  /**
   * Get a summary of all agents' work (for the orchestrator).
   */
  getOrchestratorSummary(): string {
    const parts: string[] = [];

    for (const ctx of this.contexts.values()) {
      if (ctx.policy === "full") continue; // Skip orchestrator's own context

      const recentCount = ctx.messages.length;
      const lastMessage = ctx.messages[ctx.messages.length - 1];
      parts.push(
        `[${ctx.agentId}] Task: ${ctx.taskDescription} | Messages: ${recentCount}` +
        (lastMessage ? ` | Last: ${lastMessage.content.slice(0, 100)}` : "")
      );
    }

    return parts.length > 0
      ? "Agent Activity:\n" + parts.join("\n")
      : "No sub-agents active.";
  }

  /**
   * Compress a conversation into a summary message.
   * Used by /compact and when context grows too large.
   */
  compressConversation(messages: Array<{ role: string; content: string }>): string {
    if (messages.length <= 4) return messages.map(m => m.content).join("\n");

    const userMessages = messages.filter(m => m.role === "user");
    const assistantMessages = messages.filter(m => m.role === "assistant");

    const summary = [
      `Conversation summary (${messages.length} messages):`,
      `- User topics: ${userMessages.slice(-3).map(m => m.content.slice(0, 50)).join("; ")}`,
      `- Assistant actions: ${assistantMessages.slice(-2).map(m => m.content.slice(0, 80)).join("; ")}`,
    ].join("\n");

    return summary;
  }

  /**
   * Get total message count across all agents.
   */
  getTotalMessages(): number {
    let total = 0;
    for (const ctx of this.contexts.values()) {
      total += ctx.messages.length;
    }
    return total;
  }

  /**
   * Clear all contexts.
   */
  clear(): void {
    this.contexts.clear();
    this.globalHistory = [];
  }

  // ── Private ─────────────────────────────────────────────────

  private trimMessages(ctx: AgentContext): void {
    // Rough token estimation: 4 chars per token
    let totalTokens = this.estimateTokens(ctx.messages, ctx.taskDescription);

    while (totalTokens > ctx.maxTokens && ctx.messages.length > 2) {
      // Remove oldest non-system message
      const idx = ctx.messages.findIndex(m => m.role !== "system");
      if (idx >= 0) {
        ctx.messages.splice(idx, 1);
        totalTokens = this.estimateTokens(ctx.messages, ctx.taskDescription);
      } else {
        break;
      }
    }
  }

  private estimateTokens(
    messages: Array<{ role: string; content: string }>,
    systemContext: string
  ): number {
    let chars = systemContext.length;
    for (const m of messages) {
      chars += m.content.length + 10; // overhead per message
    }
    return Math.ceil(chars / 4);
  }
}

// ── Singleton ─────────────────────────────────────────────────

let _contextManager: ContextManager | null = null;

export function getContextManager(): ContextManager {
  if (!_contextManager) {
    _contextManager = new ContextManager();
  }
  return _contextManager;
}
