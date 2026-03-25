/**
 * 8gent Code - Context Window Optimizer
 *
 * Tracks token budget across system prompt, injected memories, and conversation
 * history. Applies truncation strategies to keep total usage within the model's
 * context window while preserving the most valuable content.
 *
 * Zero external dependencies. Pure TypeScript.
 *
 * Usage:
 *   const optimizer = new ContextOptimizer({ contextWindow: 128_000 });
 *   const result = optimizer.optimize({ systemPrompt, memories, history });
 */

function estimateTokens(text: string): number {
  if (!text) return 0;
  const codeChars = (text.match(/[{}()=>;\[\]]/g) || []).length;
  const lines = text.split("\n");
  const indentedLines = lines.filter((l) => /^[ \t]{2,}/.test(l)).length;
  const codeCharRatio = codeChars / Math.max(text.length, 1);
  const indentRatio = indentedLines / Math.max(lines.length, 1);
  let charsPerToken: number;
  if (codeCharRatio > 0.06 || indentRatio > 0.4) {
    charsPerToken = 3.0; // code
  } else if (codeCharRatio > 0.03 || indentRatio > 0.2) {
    charsPerToken = 3.5; // mixed
  } else {
    charsPerToken = 4.0; // prose
  }
  return Math.ceil(text.length / charsPerToken);
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface BudgetAllocation {
  /** Total tokens available in the model's context window */
  contextWindow: number;
  /** Tokens reserved for the model's own completion output */
  outputReserve: number;
  /** Tokens available for all input (contextWindow - outputReserve) */
  inputBudget: number;
  /** Max tokens for the system prompt */
  systemPromptBudget: number;
  /** Max tokens for injected memory context */
  memoriesBudget: number;
  /** Tokens remaining for conversation history */
  historyBudget: number;
}

export interface TokenUsage {
  systemPrompt: number;
  memories: number;
  history: number;
  total: number;
  /** 0-1, fraction of inputBudget consumed */
  utilization: number;
}

export interface OptimizeInput {
  /** The assembled system prompt (already rendered string) */
  systemPrompt: string;
  /** Memory context block (e.g. from buildMemoryContext()) */
  memories?: string;
  /** Full conversation history, oldest-first */
  history: Message[];
}

export interface OptimizeResult {
  /** Trimmed history that fits within historyBudget */
  history: Message[];
  /** Memory context, possibly truncated */
  memories: string;
  /** System prompt, possibly truncated */
  systemPrompt: string;
  /** Breakdown of allocated vs used tokens */
  budget: BudgetAllocation;
  /** Actual token counts after truncation */
  usage: TokenUsage;
  /** True if any truncation was applied */
  truncated: boolean;
  /** Human-readable log of truncation decisions */
  log: string[];
}

export interface ContextOptimizerConfig {
  /**
   * Model context window in tokens.
   * Defaults to 128_000 (GPT-4o / Llama 3 70B).
   */
  contextWindow?: number;
  /**
   * Tokens reserved for the model's completion output.
   * Defaults to 4_096.
   */
  outputReserve?: number;
  /**
   * Fraction of inputBudget dedicated to the system prompt.
   * Defaults to 0.20 (20%).
   */
  systemPromptFraction?: number;
  /**
   * Fraction of inputBudget dedicated to memory context.
   * Defaults to 0.10 (10%).
   */
  memoriesFraction?: number;
  /**
   * Fraction of inputBudget dedicated to conversation history.
   * Remaining budget after system + memories goes here by default.
   */
  historyFraction?: number;
  /**
   * Truncation strategy for conversation history.
   * - "oldest-first": drop oldest messages first (default)
   * - "summarize-middle": keep first N + last M, drop middle
   * - "sliding-window": keep only the last N tokens of history
   */
  historyStrategy?: "oldest-first" | "summarize-middle" | "sliding-window";
  /**
   * When using "summarize-middle", how many messages to keep at the start.
   * Defaults to 4.
   */
  summaryAnchorHead?: number;
  /**
   * When using "summarize-middle", how many messages to keep at the end.
   * Defaults to 8.
   */
  summaryAnchorTail?: number;
}

export class ContextOptimizer {
  private readonly contextWindow: number;
  private readonly outputReserve: number;
  private readonly systemPromptFraction: number;
  private readonly memoriesFraction: number;
  private readonly historyFraction: number;
  private readonly historyStrategy: NonNullable<ContextOptimizerConfig["historyStrategy"]>;
  private readonly summaryAnchorHead: number;
  private readonly summaryAnchorTail: number;

  constructor(config: ContextOptimizerConfig = {}) {
    this.contextWindow = config.contextWindow ?? 128_000;
    this.outputReserve = config.outputReserve ?? 4_096;
    this.systemPromptFraction = config.systemPromptFraction ?? 0.20;
    this.memoriesFraction = config.memoriesFraction ?? 0.10;
    this.historyFraction =
      config.historyFraction ?? 1 - this.systemPromptFraction - this.memoriesFraction;
    this.historyStrategy = config.historyStrategy ?? "oldest-first";
    this.summaryAnchorHead = config.summaryAnchorHead ?? 4;
    this.summaryAnchorTail = config.summaryAnchorTail ?? 8;
  }

  computeBudget(): BudgetAllocation {
    const inputBudget = this.contextWindow - this.outputReserve;
    return {
      contextWindow: this.contextWindow,
      outputReserve: this.outputReserve,
      inputBudget,
      systemPromptBudget: Math.floor(inputBudget * this.systemPromptFraction),
      memoriesBudget: Math.floor(inputBudget * this.memoriesFraction),
      historyBudget: Math.floor(inputBudget * this.historyFraction),
    };
  }

  optimize(input: OptimizeInput): OptimizeResult {
    const log: string[] = [];
    const budget = this.computeBudget();
    let truncated = false;

    const { text: systemPrompt, truncated: spTruncated } = this.truncateText(
      input.systemPrompt, budget.systemPromptBudget, "system prompt"
    );
    if (spTruncated) {
      truncated = true;
      log.push(`system prompt truncated: ${estimateTokens(input.systemPrompt)} -> ${estimateTokens(systemPrompt)} tokens`);
    }

    const rawMemories = input.memories ?? "";
    const { text: memories, truncated: memTruncated } = this.truncateText(
      rawMemories, budget.memoriesBudget, "memories"
    );
    if (memTruncated) {
      truncated = true;
      log.push(`memories truncated: ${estimateTokens(rawMemories)} -> ${estimateTokens(memories)} tokens`);
    }

    const { messages: history, truncated: histTruncated, log: histLog } =
      this.truncateHistory(input.history, budget.historyBudget);
    if (histTruncated) {
      truncated = true;
      log.push(...histLog);
    }

    const spTokens = estimateTokens(systemPrompt);
    const memTokens = estimateTokens(memories);
    const histTokens = history.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    const totalTokens = spTokens + memTokens + histTokens;
    const usage: TokenUsage = {
      systemPrompt: spTokens,
      memories: memTokens,
      history: histTokens,
      total: totalTokens,
      utilization: totalTokens / budget.inputBudget,
    };

    log.push(
      truncated
        ? `after truncation: ${totalTokens}/${budget.inputBudget} tokens (${(usage.utilization * 100).toFixed(1)}% utilized)`
        : `no truncation needed: ${totalTokens}/${budget.inputBudget} tokens (${(usage.utilization * 100).toFixed(1)}% utilized)`
    );

    return { history, memories, systemPrompt, budget, usage, truncated, log };
  }

  private truncateHistory(
    history: Message[],
    budget: number
  ): { messages: Message[]; truncated: boolean; log: string[] } {
    const totalTokens = history.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    if (totalTokens <= budget) return { messages: history, truncated: false, log: [] };

    const log = [
      `history over budget (${totalTokens} > ${budget} tokens), applying "${this.historyStrategy}" strategy`,
    ];

    let result: Message[];
    switch (this.historyStrategy) {
      case "sliding-window": result = this.slidingWindow(history, budget); break;
      case "summarize-middle": result = this.summarizeMiddle(history, budget); break;
      default: result = this.oldestFirst(history, budget); break;
    }

    const afterTokens = result.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    log.push(`history: ${history.length} -> ${result.length} messages, ${totalTokens} -> ${afterTokens} tokens`);
    return { messages: result, truncated: true, log };
  }

  private oldestFirst(history: Message[], budget: number): Message[] {
    const messages = [...history];
    let tokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    while (tokens > budget && messages.length > 0) {
      const dropped = messages.shift()!;
      tokens -= estimateTokens(dropped.content);
    }
    return messages;
  }

  private slidingWindow(history: Message[], budget: number): Message[] {
    const result: Message[] = [];
    let tokens = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      const msgTokens = estimateTokens(history[i].content);
      if (tokens + msgTokens > budget) break;
      result.unshift(history[i]);
      tokens += msgTokens;
    }
    return result;
  }

  private summarizeMiddle(history: Message[], budget: number): Message[] {
    const head = history.slice(0, this.summaryAnchorHead);
    const tail = history.slice(-this.summaryAnchorTail);
    if (history.length <= this.summaryAnchorHead + this.summaryAnchorTail) {
      return this.oldestFirst(history, budget);
    }
    const droppedCount = history.length - this.summaryAnchorHead - this.summaryAnchorTail;
    const placeholder: Message = {
      role: "user",
      content: `[${droppedCount} earlier messages omitted to fit context window]`,
    };
    const candidate = [...head, placeholder, ...tail];
    const candidateTokens = candidate.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    return candidateTokens > budget ? this.oldestFirst(tail, budget) : candidate;
  }

  private truncateText(
    text: string,
    budget: number,
    _label: string
  ): { text: string; truncated: boolean } {
    const tokens = estimateTokens(text);
    if (tokens <= budget) return { text, truncated: false };
    const ratio = text.length / tokens;
    const targetChars = Math.floor(budget * ratio * 0.95);
    return {
      text: text.slice(0, targetChars) + "\n[...truncated to fit context window]",
      truncated: true,
    };
  }

  /**
   * Returns a token breakdown string for debugging without modifying anything.
   */
  inspect(input: OptimizeInput): string {
    const budget = this.computeBudget();
    const spTokens = estimateTokens(input.systemPrompt);
    const memTokens = estimateTokens(input.memories ?? "");
    const histTokens = input.history.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    const total = spTokens + memTokens + histTokens;
    const pct = ((total / budget.inputBudget) * 100).toFixed(1);
    return [
      `Context window: ${budget.contextWindow.toLocaleString()} tokens`,
      `Output reserve: ${budget.outputReserve.toLocaleString()} tokens`,
      `Input budget:   ${budget.inputBudget.toLocaleString()} tokens`,
      ``,
      `  System prompt: ${spTokens.toLocaleString()} / ${budget.systemPromptBudget.toLocaleString()} (budget ${(this.systemPromptFraction * 100).toFixed(0)}%)`,
      `  Memories:      ${memTokens.toLocaleString()} / ${budget.memoriesBudget.toLocaleString()} (budget ${(this.memoriesFraction * 100).toFixed(0)}%)`,
      `  History:       ${histTokens.toLocaleString()} / ${budget.historyBudget.toLocaleString()} (budget ${(this.historyFraction * 100).toFixed(0)}%)`,
      ``,
      `  Total used:    ${total.toLocaleString()} / ${budget.inputBudget.toLocaleString()} (${pct}%)`,
      `  Status:        ${total <= budget.inputBudget ? "OK" : "OVER BUDGET"}`,
    ].join("\n");
  }
}
