/**
 * Cost Tracker - LLM token usage tracking and budget alerting
 *
 * Tracks per-model token usage, estimates cost from pricing tables,
 * generates daily/weekly reports, and alerts on budget thresholds.
 */

// Pricing per 1M tokens (USD) - input / output
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // OpenRouter free tier
  'qwen/qwen3-235b-a22b:free': { input: 0, output: 0 },
  'deepseek/deepseek-chat-v3-0324:free': { input: 0, output: 0 },
  'google/gemini-2.0-flash-exp:free': { input: 0, output: 0 },
  // OpenRouter paid
  'anthropic/claude-sonnet-4': { input: 3.0, output: 15.0 },
  'anthropic/claude-opus-4': { input: 15.0, output: 75.0 },
  'openai/gpt-4o': { input: 2.5, output: 10.0 },
  'google/gemini-2.0-flash': { input: 0.1, output: 0.4 },
  'deepseek/deepseek-chat-v3-0324': { input: 0.5, output: 1.5 },
  // Local (Ollama) - free
  'ollama/qwen3.5': { input: 0, output: 0 },
  'ollama/deepseek-r1:14b': { input: 0, output: 0 },
};

export interface UsageEntry {
  model: string;
  inputTokens: number;
  outputTokens: number;
  timestamp: number; // epoch ms
  sessionId?: string;
}

export interface CostReport {
  period: 'daily' | 'weekly';
  startMs: number;
  endMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUsd: number;
  byModel: Record<string, { input: number; output: number; costUsd: number }>;
}

export interface BudgetAlert {
  level: 'info' | 'warning' | 'critical';
  message: string;
  currentSpend: number;
  budgetLimit: number;
  percentUsed: number;
}

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

export class CostTracker {
  private entries: UsageEntry[] = [];
  private dailyBudgetUsd: number;
  private weeklyBudgetUsd: number;

  constructor(opts?: { dailyBudgetUsd?: number; weeklyBudgetUsd?: number }) {
    this.dailyBudgetUsd = opts?.dailyBudgetUsd ?? 5;
    this.weeklyBudgetUsd = opts?.weeklyBudgetUsd ?? 25;
  }

  /** Register a completed LLM call */
  record(entry: UsageEntry): BudgetAlert | null {
    this.entries.push(entry);
    return this.checkBudget();
  }

  /** Estimate cost for a single entry */
  estimateCost(entry: Pick<UsageEntry, 'model' | 'inputTokens' | 'outputTokens'>): number {
    const pricing = MODEL_PRICING[entry.model];
    if (!pricing) return 0;
    const inputCost = (entry.inputTokens / 1_000_000) * pricing.input;
    const outputCost = (entry.outputTokens / 1_000_000) * pricing.output;
    return inputCost + outputCost;
  }

  /** Generate a cost report for a time period */
  report(period: 'daily' | 'weekly'): CostReport {
    const now = Date.now();
    const windowMs = period === 'daily' ? DAY_MS : WEEK_MS;
    const startMs = now - windowMs;
    const filtered = this.entries.filter((e) => e.timestamp >= startMs);

    const byModel: CostReport['byModel'] = {};
    let totalInput = 0;
    let totalOutput = 0;
    let totalCost = 0;

    for (const entry of filtered) {
      const cost = this.estimateCost(entry);
      totalInput += entry.inputTokens;
      totalOutput += entry.outputTokens;
      totalCost += cost;

      if (!byModel[entry.model]) {
        byModel[entry.model] = { input: 0, output: 0, costUsd: 0 };
      }
      byModel[entry.model].input += entry.inputTokens;
      byModel[entry.model].output += entry.outputTokens;
      byModel[entry.model].costUsd += cost;
    }

    return {
      period,
      startMs,
      endMs: now,
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      estimatedCostUsd: Math.round(totalCost * 10000) / 10000,
      byModel,
    };
  }

  /** Check if current spend is approaching budget limits */
  private checkBudget(): BudgetAlert | null {
    const daily = this.report('daily');
    const weekly = this.report('weekly');

    // Check daily first (tighter window)
    const dailyPct = this.dailyBudgetUsd > 0
      ? (daily.estimatedCostUsd / this.dailyBudgetUsd) * 100
      : 0;
    if (dailyPct >= 90) {
      return {
        level: 'critical',
        message: `Daily spend at ${dailyPct.toFixed(0)}% of limit`,
        currentSpend: daily.estimatedCostUsd,
        budgetLimit: this.dailyBudgetUsd,
        percentUsed: dailyPct,
      };
    }
    if (dailyPct >= 70) {
      return {
        level: 'warning',
        message: `Daily spend at ${dailyPct.toFixed(0)}% of limit`,
        currentSpend: daily.estimatedCostUsd,
        budgetLimit: this.dailyBudgetUsd,
        percentUsed: dailyPct,
      };
    }

    // Then weekly
    const weeklyPct = this.weeklyBudgetUsd > 0
      ? (weekly.estimatedCostUsd / this.weeklyBudgetUsd) * 100
      : 0;
    if (weeklyPct >= 80) {
      return {
        level: 'warning',
        message: `Weekly spend at ${weeklyPct.toFixed(0)}% of limit`,
        currentSpend: weekly.estimatedCostUsd,
        budgetLimit: this.weeklyBudgetUsd,
        percentUsed: weeklyPct,
      };
    }

    return null;
  }

  /** Update pricing for a model (e.g. when providers change rates) */
  static setPricing(model: string, input: number, output: number): void {
    MODEL_PRICING[model] = { input, output };
  }

  /** Get all tracked entries (for persistence) */
  getEntries(): ReadonlyArray<UsageEntry> {
    return this.entries;
  }

  /** Load entries from persistence */
  loadEntries(entries: UsageEntry[]): void {
    this.entries = [...entries];
  }
}
