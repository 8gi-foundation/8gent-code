/**
 * TokenBudget - calculates and allocates token budgets across context layers.
 *
 * Segments: system prompt, user context, memory injection, tool definitions,
 * conversation history, and response reservation. Tracks live usage per segment,
 * surfaces overflow warnings, and normalises fractional allocations to the active
 * model's context window.
 */

export interface BudgetSegment {
  name: string;
  allocated: number;
  used: number;
  remaining: number;
  percentUsed: number;
}

export interface BudgetAllocation {
  modelLimit: number;
  segments: Record<string, BudgetSegment>;
  totalAllocated: number;
  totalUsed: number;
  totalRemaining: number;
  overBudget: boolean;
}

export interface SegmentConfig {
  systemPrompt?: number;
  userContext?: number;
  memoryInjection?: number;
  toolDefinitions?: number;
  conversationHistory?: number;
  responseReservation?: number;
}

// Model context window limits (tokens).
const MODEL_LIMITS: Record<string, number> = {
  "gpt-4o": 128_000,
  "gpt-4-turbo": 128_000,
  "gpt-3.5-turbo": 16_385,
  "claude-3-5-sonnet": 200_000,
  "claude-3-opus": 200_000,
  "claude-3-haiku": 200_000,
  "qwen2.5-coder": 32_768,
  "llama3.1": 131_072,
  "gemma2": 8_192,
  default: 32_768,
};

// Default segment allocation as fractions of total budget.
const DEFAULT_FRACTIONS: Required<SegmentConfig> = {
  systemPrompt: 0.10,
  userContext: 0.05,
  memoryInjection: 0.15,
  toolDefinitions: 0.10,
  conversationHistory: 0.45,
  responseReservation: 0.15,
};

/**
 * Estimate token count from a string.
 * Approximation: ~4 chars per token for English prose, ~3 for code.
 */
export function estimateTokens(text: string, isCode = false): number {
  if (!text) return 0;
  const charsPerToken = isCode ? 3 : 4;
  return Math.ceil(text.length / charsPerToken);
}

/**
 * Estimate tokens from a list of chat messages (OpenAI / Anthropic format).
 */
export function estimateMessagesTokens(
  messages: Array<{ role: string; content: string }>
): number {
  // 4 overhead tokens per message (role + separators).
  return messages.reduce(
    (sum, m) => sum + estimateTokens(m.content) + 4,
    0
  );
}

export class TokenBudget {
  private modelLimit: number;
  private allocations: Required<SegmentConfig>;
  private usage: Record<keyof SegmentConfig, number>;

  constructor(model = "default", overrides: SegmentConfig = {}) {
    this.modelLimit = MODEL_LIMITS[model] ?? MODEL_LIMITS["default"];

    // Merge fractions; re-normalise so they always sum to 1.
    const merged = { ...DEFAULT_FRACTIONS, ...overrides } as Required<SegmentConfig>;
    const total = Object.values(merged).reduce((s, v) => s + v, 0);
    const scale = total > 0 ? 1 / total : 1;

    this.allocations = Object.fromEntries(
      Object.entries(merged).map(([k, v]) => [k, v * scale])
    ) as Required<SegmentConfig>;

    this.usage = {
      systemPrompt: 0,
      userContext: 0,
      memoryInjection: 0,
      toolDefinitions: 0,
      conversationHistory: 0,
      responseReservation: 0,
    };
  }

  /** Record token usage for a segment. */
  track(segment: keyof SegmentConfig, tokens: number): void {
    this.usage[segment] = tokens;
  }

  /** Convenience: track a segment from raw text. */
  trackText(segment: keyof SegmentConfig, text: string, isCode = false): void {
    this.track(segment, estimateTokens(text, isCode));
  }

  /** Return allocated token count for a segment. */
  limitFor(segment: keyof SegmentConfig): number {
    return Math.floor(this.modelLimit * this.allocations[segment]);
  }

  /** Return full budget snapshot. */
  snapshot(): BudgetAllocation {
    const segments: Record<string, BudgetSegment> = {};
    let totalAllocated = 0;
    let totalUsed = 0;

    for (const key of Object.keys(this.allocations) as Array<keyof SegmentConfig>) {
      const allocated = this.limitFor(key);
      const used = this.usage[key];
      totalAllocated += allocated;
      totalUsed += used;
      segments[key] = {
        name: key,
        allocated,
        used,
        remaining: Math.max(0, allocated - used),
        percentUsed: allocated > 0 ? Math.round((used / allocated) * 100) : 0,
      };
    }

    return {
      modelLimit: this.modelLimit,
      segments,
      totalAllocated,
      totalUsed,
      totalRemaining: Math.max(0, this.modelLimit - totalUsed),
      overBudget: totalUsed > this.modelLimit,
    };
  }

  /** Returns segments that have exceeded their allocation. */
  overflowingSegments(): BudgetSegment[] {
    const snap = this.snapshot();
    return Object.values(snap.segments).filter(s => s.used > s.allocated);
  }

  /** True if total usage is within the model context limit. */
  isWithinLimit(): boolean {
    return !this.snapshot().overBudget;
  }
}
