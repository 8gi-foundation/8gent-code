/**
 * 8gent Code - Context Engineering
 *
 * Utilities for efficient context management, token optimization,
 * and structured information retrieval.
 */

// ============================================
// Types
// ============================================

export interface ContextWindow {
  maxTokens: number;
  usedTokens: number;
  systemPromptTokens: number;
  conversationTokens: number;
  toolResultTokens: number;
  pendingTokens: number;
}

export interface ContextPriority {
  id: string;
  content: string;
  priority: number;    // 1-10, higher = more important
  category: "system" | "user" | "tool" | "result" | "history";
  tokens: number;
  essential: boolean;  // Cannot be dropped
  decay: number;       // Rate at which priority decreases (0-1)
}

export interface ContextSummary {
  files: string[];
  symbols: string[];
  commands: string[];
  changes: string[];
  errors: string[];
}

// ============================================
// Token Estimation
// ============================================

/**
 * Estimate token count for text (rough approximation)
 * Uses ~4 characters per token as a baseline
 */
export function estimateTokens(text: string): number {
  // Account for whitespace and punctuation
  const words = text.split(/\s+/).length;
  const chars = text.length;

  // Hybrid estimation: words * 1.3 + chars/4
  return Math.ceil((words * 1.3 + chars / 4) / 2);
}

/**
 * Create a context window tracker
 */
export function createContextWindow(maxTokens: number = 128000): ContextWindow {
  return {
    maxTokens,
    usedTokens: 0,
    systemPromptTokens: 0,
    conversationTokens: 0,
    toolResultTokens: 0,
    pendingTokens: 0,
  };
}

/**
 * Update context window usage
 */
export function updateContextWindow(
  window: ContextWindow,
  category: "system" | "conversation" | "tool" | "pending",
  tokens: number
): ContextWindow {
  const updated = { ...window };

  switch (category) {
    case "system":
      updated.systemPromptTokens = tokens;
      break;
    case "conversation":
      updated.conversationTokens += tokens;
      break;
    case "tool":
      updated.toolResultTokens += tokens;
      break;
    case "pending":
      updated.pendingTokens = tokens;
      break;
  }

  updated.usedTokens =
    updated.systemPromptTokens +
    updated.conversationTokens +
    updated.toolResultTokens +
    updated.pendingTokens;

  return updated;
}

/**
 * Check if context window has room for new content
 */
export function hasContextRoom(window: ContextWindow, neededTokens: number, margin: number = 0.1): boolean {
  const available = window.maxTokens * (1 - margin);
  return window.usedTokens + neededTokens <= available;
}

/**
 * Get context usage percentage
 */
export function getContextUsage(window: ContextWindow): number {
  return Math.round((window.usedTokens / window.maxTokens) * 100);
}

// ============================================
// Context Compression
// ============================================

/**
 * Compress a message while preserving essential information
 */
export function compressMessage(content: string, maxTokens: number = 500): string {
  const currentTokens = estimateTokens(content);
  if (currentTokens <= maxTokens) return content;

  // Strategy 1: Remove code blocks, keep summaries
  let compressed = content.replace(/```[\s\S]*?```/g, "[code block]");

  // Strategy 2: Truncate long lines
  const lines = compressed.split("\n");
  compressed = lines
    .map(line => line.length > 200 ? line.slice(0, 197) + "..." : line)
    .join("\n");

  // Strategy 3: Remove repetitive content
  compressed = compressed.replace(/(.{20,}?)\1+/g, "$1 [repeated]");

  // Strategy 4: Final truncation if needed
  const targetChars = maxTokens * 4;
  if (compressed.length > targetChars) {
    compressed = compressed.slice(0, targetChars - 50) + "\n...[truncated]";
  }

  return compressed;
}

/**
 * Compress tool result to essential information
 */
export function compressToolResult(toolName: string, result: string, maxTokens: number = 200): string {
  const currentTokens = estimateTokens(result);
  if (currentTokens <= maxTokens) return result;

  switch (toolName) {
    case "read_file":
      // Keep first and last parts
      const lines = result.split("\n");
      if (lines.length > 20) {
        return [
          ...lines.slice(0, 10),
          `... [${lines.length - 20} lines omitted] ...`,
          ...lines.slice(-10),
        ].join("\n");
      }
      break;

    case "search_symbols":
    case "list_files":
      // Keep first N items
      const items = result.split("\n").filter(l => l.trim());
      if (items.length > 20) {
        return [
          ...items.slice(0, 15),
          `... and ${items.length - 15} more items`,
        ].join("\n");
      }
      break;

    case "run_command":
      // Keep last N lines (usually the important output)
      const outputLines = result.split("\n");
      if (outputLines.length > 30) {
        return [
          `[${outputLines.length - 30} lines omitted]`,
          ...outputLines.slice(-30),
        ].join("\n");
      }
      break;

    case "git_diff":
      // Summarize diff
      const diffStats = extractDiffStats(result);
      if (diffStats) {
        return `${diffStats}\n\n[Full diff truncated]`;
      }
      break;
  }

  // Default compression
  return compressMessage(result, maxTokens);
}

/**
 * Extract summary stats from git diff
 */
function extractDiffStats(diff: string): string | null {
  const statLine = diff.match(/(\d+) files? changed/);
  const insertions = diff.match(/(\d+) insertions?\(\+\)/);
  const deletions = diff.match(/(\d+) deletions?\(-\)/);

  if (statLine) {
    let stats = statLine[0];
    if (insertions) stats += `, ${insertions[0]}`;
    if (deletions) stats += `, ${deletions[0]}`;
    return stats;
  }

  return null;
}

// ============================================
// Context Prioritization
// ============================================

/**
 * Create a prioritized context item
 */
export function createContextItem(
  id: string,
  content: string,
  options: {
    priority?: number;
    category?: ContextPriority["category"];
    essential?: boolean;
    decay?: number;
  } = {}
): ContextPriority {
  return {
    id,
    content,
    priority: options.priority || 5,
    category: options.category || "history",
    tokens: estimateTokens(content),
    essential: options.essential || false,
    decay: options.decay || 0.1,
  };
}

/**
 * Sort context items by priority (respecting essential flag)
 */
export function prioritizeContext(items: ContextPriority[]): ContextPriority[] {
  return [...items].sort((a, b) => {
    // Essential items always come first
    if (a.essential && !b.essential) return -1;
    if (!a.essential && b.essential) return 1;

    // Then sort by priority
    return b.priority - a.priority;
  });
}

/**
 * Select context items that fit within token budget
 */
export function selectContextItems(
  items: ContextPriority[],
  maxTokens: number
): ContextPriority[] {
  const sorted = prioritizeContext(items);
  const selected: ContextPriority[] = [];
  let usedTokens = 0;

  for (const item of sorted) {
    if (item.essential) {
      // Essential items are always included
      selected.push(item);
      usedTokens += item.tokens;
    } else if (usedTokens + item.tokens <= maxTokens) {
      selected.push(item);
      usedTokens += item.tokens;
    }
  }

  return selected;
}

/**
 * Apply decay to context priorities (call periodically)
 */
export function applyPriorityDecay(items: ContextPriority[]): ContextPriority[] {
  return items.map(item => ({
    ...item,
    priority: Math.max(1, item.priority * (1 - item.decay)),
  }));
}

// ============================================
// Conversation Summarization
// ============================================

/**
 * Summarize conversation history for context preservation
 */
export function summarizeConversation(
  messages: Array<{ role: string; content: string }>
): ContextSummary {
  const summary: ContextSummary = {
    files: [],
    symbols: [],
    commands: [],
    changes: [],
    errors: [],
  };

  for (const msg of messages) {
    const content = msg.content;

    // Extract file references
    const files = content.match(/(?:src|lib|app|packages)\/[\w./\-]+\.\w+/g) || [];
    summary.files.push(...files);

    // Extract symbol references
    const symbols = content.match(/(?:function|class|const|let|var)\s+(\w+)/g) || [];
    summary.symbols.push(...symbols.map(s => s.split(/\s+/)[1]));

    // Extract commands
    const commands = content.match(/(?:npm|bun|git|npx)\s+[\w\s\-]+/g) || [];
    summary.commands.push(...commands);

    // Extract errors
    if (content.toLowerCase().includes("error") || content.toLowerCase().includes("failed")) {
      const errorLine = content.split("\n").find(l =>
        l.toLowerCase().includes("error") || l.toLowerCase().includes("failed")
      );
      if (errorLine) summary.errors.push(errorLine.slice(0, 100));
    }
  }

  // Deduplicate
  summary.files = Array.from(new Set(summary.files)).slice(0, 20);
  summary.symbols = Array.from(new Set(summary.symbols)).slice(0, 20);
  summary.commands = Array.from(new Set(summary.commands)).slice(0, 10);
  summary.errors = Array.from(new Set(summary.errors)).slice(0, 5);

  return summary;
}

/**
 * Format context summary as a concise string
 */
export function formatContextSummary(summary: ContextSummary): string {
  const parts: string[] = [];

  if (summary.files.length > 0) {
    parts.push(`Files: ${summary.files.slice(0, 5).join(", ")}${summary.files.length > 5 ? ` (+${summary.files.length - 5})` : ""}`);
  }

  if (summary.symbols.length > 0) {
    parts.push(`Symbols: ${summary.symbols.slice(0, 5).join(", ")}${summary.symbols.length > 5 ? ` (+${summary.symbols.length - 5})` : ""}`);
  }

  if (summary.commands.length > 0) {
    parts.push(`Commands: ${summary.commands.slice(0, 3).join("; ")}`);
  }

  if (summary.errors.length > 0) {
    parts.push(`Errors: ${summary.errors.length}`);
  }

  return parts.join(" | ");
}

// ============================================
// Structured Thinking Blocks
// ============================================

/**
 * Generate a structured thinking block for the agent
 */
export function generateThinkingBlock(
  task: string,
  context: {
    files?: string[];
    symbols?: string[];
    previousActions?: string[];
  }
): string {
  return `<thinking>
## Task Analysis
${task}

## Available Context
- Files: ${context.files?.slice(0, 5).join(", ") || "None identified yet"}
- Symbols: ${context.symbols?.slice(0, 5).join(", ") || "None identified yet"}
- Previous actions: ${context.previousActions?.length || 0}

## Planning
1. What information do I need?
2. What tools should I use?
3. What order should I execute?
4. How will I verify success?

## Execution Plan
[Generate numbered steps here]
</thinking>`;
}

/**
 * Parse a thinking block from agent response
 */
export function parseThinkingBlock(response: string): {
  analysis: string;
  plan: string[];
  foundThinking: boolean;
} {
  const thinkingMatch = response.match(/<thinking>([\s\S]*?)<\/thinking>/);

  if (!thinkingMatch) {
    return { analysis: "", plan: [], foundThinking: false };
  }

  const thinkingContent = thinkingMatch[1];

  // Extract plan steps
  const planMatch = thinkingContent.match(/## Execution Plan\n([\s\S]*?)(?:\n##|$)/);
  const planSteps: string[] = [];

  if (planMatch) {
    const planLines = planMatch[1].split("\n");
    for (const line of planLines) {
      const stepMatch = line.match(/^\d+\.\s*(.+)/);
      if (stepMatch) {
        planSteps.push(stepMatch[1].trim());
      }
    }
  }

  return {
    analysis: thinkingContent,
    plan: planSteps,
    foundThinking: true,
  };
}
