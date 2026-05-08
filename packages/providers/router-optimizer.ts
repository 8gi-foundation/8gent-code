/**
 * RouterOptimizer - Adaptive model router for 8gent Code
 *
 * Classifies tasks by complexity, maps them to optimal models,
 * tracks per-model performance, and applies cost-aware routing.
 *
 * Zero external dependencies. Uses only Node/Bun built-ins.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ============================================
// Types
// ============================================

export type TaskComplexity = "trivial" | "simple" | "moderate" | "complex" | "expert";

export type TaskCategory =
  | "chat"
  | "code-gen"
  | "code-review"
  | "debugging"
  | "planning"
  | "research"
  | "summarization"
  | "tool-use"
  | "math"
  | "creative";

export interface TaskProfile {
  complexity: TaskComplexity;
  category: TaskCategory;
  requiresTools: boolean;
  requiresVision: boolean;
  estimatedTokens: number;
  /** Free cloud only - user has no paid keys available */
  freeOnly: boolean;
  /** Prefer local model over cloud */
  preferLocal: boolean;
}

export interface ModelCandidate {
  provider: string;
  model: string;
  /** Estimated cost per 1k tokens in micro-cents. 0 = free/local. */
  costPer1kTokens: number;
  supportsTools: boolean;
  supportsVision: boolean;
  /** Rough quality tier: 1 (weakest) - 5 (strongest) */
  qualityTier: number;
  /** Max context window in tokens */
  contextWindow: number;
  /** Local inference - no network latency */
  isLocal: boolean;
}

export interface RouteDecision {
  provider: string;
  model: string;
  complexity: TaskComplexity;
  category: TaskCategory;
  reasoning: string;
  estimatedCostMicroCents: number;
  fallbackChain: Array<{ provider: string; model: string }>;
}

export interface PerformanceRecord {
  provider: string;
  model: string;
  category: TaskCategory;
  complexity: TaskComplexity;
  latencyMs: number;
  success: boolean;
  tokenCount: number;
  timestamp: number;
}

export interface ModelStats {
  provider: string;
  model: string;
  totalRequests: number;
  successRate: number;
  avgLatencyMs: number;
  avgTokenCount: number;
  lastUsed: number;
  categoryScores: Partial<Record<TaskCategory, number>>;
}

export interface RouterOptimizerConfig {
  /** Path for persisting performance history */
  historyPath?: string;
  /** Max history records to retain */
  maxHistorySize?: number;
  /** Weight for latency vs quality in scoring (0 = quality only, 1 = speed only) */
  latencyWeight?: number;
  /** Minimum success rate before a model is deprioritized (0-1) */
  minSuccessRate?: number;
  /** Prefer free/local models unless task requires more */
  frugalMode?: boolean;
}

// ============================================
// Model Catalog
// ============================================

const MODEL_CATALOG: ModelCandidate[] = [
  // Local / 8gent
  {
    provider: "8gent",
    model: "eight-1.0-q3:14b",
    costPer1kTokens: 0,
    supportsTools: true,
    supportsVision: true,
    qualityTier: 3,
    contextWindow: 32768,
    isLocal: true,
  },
  {
    provider: "ollama",
    model: "qwen3.5:latest",
    costPer1kTokens: 0,
    supportsTools: true,
    supportsVision: false,
    qualityTier: 3,
    contextWindow: 32768,
    isLocal: true,
  },
  {
    provider: "ollama",
    model: "qwen3:14b",
    costPer1kTokens: 0,
    supportsTools: true,
    supportsVision: false,
    qualityTier: 3,
    contextWindow: 32768,
    isLocal: true,
  },
  {
    provider: "ollama",
    model: "devstral:latest",
    costPer1kTokens: 0,
    supportsTools: true,
    supportsVision: false,
    qualityTier: 4,
    contextWindow: 32768,
    isLocal: true,
  },
  // OpenRouter free tier
  {
    provider: "openrouter",
    model: "meta-llama/llama-3-8b-instruct:free",
    costPer1kTokens: 0,
    supportsTools: false,
    supportsVision: false,
    qualityTier: 2,
    contextWindow: 8192,
    isLocal: false,
  },
  {
    provider: "openrouter",
    model: "meta-llama/llama-3-70b-instruct:free",
    costPer1kTokens: 0,
    supportsTools: false,
    supportsVision: false,
    qualityTier: 3,
    contextWindow: 8192,
    isLocal: false,
  },
  // Groq (fast inference)
  {
    provider: "groq",
    model: "llama-3.1-8b-instant",
    costPer1kTokens: 5,
    supportsTools: true,
    supportsVision: false,
    qualityTier: 2,
    contextWindow: 128000,
    isLocal: false,
  },
  {
    provider: "groq",
    model: "llama-3.1-70b-versatile",
    costPer1kTokens: 59,
    supportsTools: true,
    supportsVision: false,
    qualityTier: 4,
    contextWindow: 128000,
    isLocal: false,
  },
  // Anthropic
  {
    provider: "anthropic",
    model: "claude-3-haiku-20240307",
    costPer1kTokens: 25,
    supportsTools: true,
    supportsVision: true,
    qualityTier: 3,
    contextWindow: 200000,
    isLocal: false,
  },
  {
    provider: "anthropic",
    model: "claude-3-5-sonnet-20241022",
    costPer1kTokens: 300,
    supportsTools: true,
    supportsVision: true,
    qualityTier: 5,
    contextWindow: 200000,
    isLocal: false,
  },
  // OpenAI
  {
    provider: "openai",
    model: "gpt-4o-mini",
    costPer1kTokens: 15,
    supportsTools: true,
    supportsVision: true,
    qualityTier: 3,
    contextWindow: 128000,
    isLocal: false,
  },
  {
    provider: "openai",
    model: "gpt-4o",
    costPer1kTokens: 250,
    supportsTools: true,
    supportsVision: true,
    qualityTier: 5,
    contextWindow: 128000,
    isLocal: false,
  },
];

// ============================================
// Complexity Classifier
// ============================================

interface TaskSignals {
  length: number;
  hasCode: boolean;
  hasMultiStep: boolean;
  hasMath: boolean;
  hasResearch: boolean;
  toolCount: number;
  hasVision: boolean;
}

function extractSignals(prompt: string, toolCount = 0, hasVision = false): TaskSignals {
  const lower = prompt.toLowerCase();
  return {
    length: prompt.length,
    hasCode: /```|function |const |class |import |def |public |void |return /.test(lower),
    hasMultiStep: /step|first.*then|next.*finally|1[.] |2[.] /.test(lower),
    hasMath: /equation|calculate|solve|integral|derivative|proof|theorem/.test(lower),
    hasResearch: /research|analyze|compare|evaluate|summarize|review/.test(lower),
    toolCount,
    hasVision,
  };
}

function classifyComplexity(signals: TaskSignals): TaskComplexity {
  let score = 0;
  if (signals.length > 2000) score += 2;
  else if (signals.length > 500) score += 1;
  if (signals.hasMultiStep) score += 2;
  if (signals.hasMath) score += 2;
  if (signals.hasResearch) score += 1;
  if (signals.hasCode) score += 1;
  if (signals.toolCount > 3) score += 2;
  else if (signals.toolCount > 0) score += 1;
  if (score >= 7) return "expert";
  if (score >= 5) return "complex";
  if (score >= 3) return "moderate";
  if (score >= 1) return "simple";
  return "trivial";
}

function classifyCategory(prompt: string, hasTools: boolean): TaskCategory {
  const lower = prompt.toLowerCase();
  if (hasTools && /bash|shell|terminal|command|execute|run/.test(lower)) return "tool-use";
  if (/debug|error|exception|traceback|stack trace|fix|bug/.test(lower)) return "debugging";
  if (/review|refactor|improve|optimize|clean|lint/.test(lower)) return "code-review";
  if (/write code|implement|create a function|build|generate code/.test(lower)) return "code-gen";
  if (/plan|roadmap|architecture|design|spec|strategy/.test(lower)) return "planning";
  if (/research|find|search|look up|what is|explain/.test(lower)) return "research";
  if (/summarize|summary|tldr|condense|brief/.test(lower)) return "summarization";
  if (/calculate|solve|math|equation|proof/.test(lower)) return "math";
  if (/write|poem|story|creative|narrative|blog/.test(lower)) return "creative";
  return "chat";
}

// ============================================
// Scoring
// ============================================

/** Minimum quality tier required for each complexity level */
const COMPLEXITY_MIN_QUALITY: Record<TaskComplexity, number> = {
  trivial: 1,
  simple: 2,
  moderate: 3,
  complex: 4,
  expert: 5,
};

/** Category-specific provider preferences (ordered by fit) */
const CATEGORY_PREFERRED_PROVIDERS: Partial<Record<TaskCategory, string[]>> = {
  "code-gen": ["ollama", "8gent", "anthropic", "openai"],
  "code-review": ["anthropic", "openai", "ollama"],
  debugging: ["anthropic", "openai", "ollama", "8gent"],
  "tool-use": ["anthropic", "openai", "groq"],
  math: ["openai", "anthropic", "groq"],
  research: ["anthropic", "openai", "groq"],
  creative: ["anthropic", "openai", "openrouter"],
  chat: ["ollama", "8gent", "groq", "openrouter"],
  planning: ["anthropic", "openai", "groq"],
  summarization: ["groq", "openai", "anthropic", "openrouter"],
};

function scoreModel(
  candidate: ModelCandidate,
  profile: TaskProfile,
  stats: ModelStats | null,
  config: Required<RouterOptimizerConfig>
): number {
  const minQuality = COMPLEXITY_MIN_QUALITY[profile.complexity];

  // Hard filters - excluded from routing
  if (candidate.qualityTier < minQuality) return -Infinity;
  if (profile.requiresTools && !candidate.supportsTools) return -Infinity;
  if (profile.requiresVision && !candidate.supportsVision) return -Infinity;
  if (candidate.contextWindow < profile.estimatedTokens) return -Infinity;
  if (profile.freeOnly && candidate.costPer1kTokens > 0) return -Infinity;

  let score = 0;

  // Quality contribution (0-50 pts)
  score += candidate.qualityTier * 10;

  // Cost - lower is better (0-30 pts, doubled in frugal mode)
  const maxCost = 300;
  const costScore = Math.max(0, 30 - (candidate.costPer1kTokens / maxCost) * 30);
  score += config.frugalMode ? costScore * 2 : costScore;

  // Local model bonus (0-20 pts, doubled in frugal mode)
  if (candidate.isLocal) score += config.frugalMode ? 20 : 10;

  // Category affinity (0-15 pts)
  const preferred = CATEGORY_PREFERRED_PROVIDERS[profile.category] ?? [];
  const idx = preferred.indexOf(candidate.provider);
  if (idx === 0) score += 15;
  else if (idx === 1) score += 10;
  else if (idx === 2) score += 5;

  // Historical performance (0-20 pts), requires >= 3 samples
  if (stats && stats.totalRequests >= 3) {
    score += stats.successRate * 10;
    const catScore = stats.categoryScores[profile.category] ?? stats.successRate;
    score += catScore * 10;
    // Latency penalty (scaled 0-10)
    score -= Math.min(10, stats.avgLatencyMs / 2000) * config.latencyWeight;
    // Deprioritize consistently flaky models
    if (stats.successRate < config.minSuccessRate) score -= 30;
  }

  return score;
}

// ============================================
// RouterOptimizer
// ============================================

export class RouterOptimizer {
  private config: Required<RouterOptimizerConfig>;
  private history: PerformanceRecord[];
  private statsCache: Map<string, ModelStats> = new Map();

  constructor(config: RouterOptimizerConfig = {}) {
    this.config = {
      historyPath: config.historyPath ?? path.join(os.homedir(), ".8gent", "router-history.jsonl"),
      maxHistorySize: config.maxHistorySize ?? 1000,
      latencyWeight: config.latencyWeight ?? 0.3,
      minSuccessRate: config.minSuccessRate ?? 0.6,
      frugalMode: config.frugalMode ?? true,
    };
    this.history = this.loadHistory();
    this.rebuildStats();
  }

  // ============================================
  // Public API
  // ============================================

  /**
   * Classify a prompt into a TaskProfile.
   */
  classify(
    prompt: string,
    opts: {
      toolCount?: number;
      hasVision?: boolean;
      freeOnly?: boolean;
      preferLocal?: boolean;
      estimatedTokens?: number;
    } = {}
  ): TaskProfile {
    const signals = extractSignals(prompt, opts.toolCount ?? 0, opts.hasVision ?? false);
    const complexity = classifyComplexity(signals);
    const category = classifyCategory(prompt, (opts.toolCount ?? 0) > 0);
    return {
      complexity,
      category,
      requiresTools: (opts.toolCount ?? 0) > 0,
      requiresVision: opts.hasVision ?? false,
      estimatedTokens: opts.estimatedTokens ?? Math.ceil(prompt.length / 3.5),
      freeOnly: opts.freeOnly ?? false,
      preferLocal: opts.preferLocal ?? this.config.frugalMode,
    };
  }

  /**
   * Route a TaskProfile to the optimal model.
   * Returns RouteDecision with a 3-deep fallback chain.
   */
  route(profile: TaskProfile, availableProviders?: Set<string>): RouteDecision {
    const candidates = MODEL_CATALOG.filter(
      (c) => !availableProviders || availableProviders.has(c.provider)
    );

    const scored = candidates
      .map((c) => ({
        candidate: c,
        score: scoreModel(
          c,
          profile,
          this.statsCache.get(`${c.provider}::${c.model}`) ?? null,
          this.config
        ),
      }))
      .filter((s) => s.score > -Infinity)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) {
      return {
        provider: "ollama",
        model: "qwen3.5:latest",
        complexity: profile.complexity,
        category: profile.category,
        reasoning: "No suitable model found - falling back to local default",
        estimatedCostMicroCents: 0,
        fallbackChain: [],
      };
    }

    const best = scored[0].candidate;
    const fallbackChain = scored.slice(1, 4).map((s) => ({
      provider: s.candidate.provider,
      model: s.candidate.model,
    }));

    return {
      provider: best.provider,
      model: best.model,
      complexity: profile.complexity,
      category: profile.category,
      reasoning: this.buildReasoning(best, profile, scored[0].score),
      estimatedCostMicroCents: Math.ceil(
        (profile.estimatedTokens / 1000) * best.costPer1kTokens
      ),
      fallbackChain,
    };
  }

  /**
   * Convenience: classify + route in one call.
   */
  routePrompt(
    prompt: string,
    opts: {
      toolCount?: number;
      hasVision?: boolean;
      freeOnly?: boolean;
      preferLocal?: boolean;
      estimatedTokens?: number;
      availableProviders?: Set<string>;
    } = {}
  ): RouteDecision {
    const profile = this.classify(prompt, opts);
    return this.route(profile, opts.availableProviders);
  }

  /**
   * Record the outcome of a completed request for performance tracking.
   */
  record(record: Omit<PerformanceRecord, "timestamp">): void {
    const full: PerformanceRecord = { ...record, timestamp: Date.now() };
    this.history.push(full);
    if (this.history.length > this.config.maxHistorySize) {
      this.history = this.history.slice(-this.config.maxHistorySize);
    }
    this.updateStats(full);
    this.persistRecord(full);
  }

  /**
   * Get aggregated stats for a specific model.
   */
  getModelStats(provider: string, model: string): ModelStats | null {
    return this.statsCache.get(`${provider}::${model}`) ?? null;
  }

  /**
   * Get stats for all tracked models, sorted by success rate descending.
   */
  getAllStats(): ModelStats[] {
    return Array.from(this.statsCache.values()).sort(
      (a, b) => b.successRate - a.successRate
    );
  }

  /**
   * Return a high-level summary for introspection.
   */
  getSummary(): {
    trackedModels: number;
    totalRequests: number;
    topModel: string | null;
    frugalMode: boolean;
    latencyWeight: number;
  } {
    const all = this.getAllStats();
    return {
      trackedModels: all.length,
      totalRequests: all.reduce((sum, s) => sum + s.totalRequests, 0),
      topModel: all[0] ? `${all[0].provider}::${all[0].model}` : null,
      frugalMode: this.config.frugalMode,
      latencyWeight: this.config.latencyWeight,
    };
  }

  /**
   * Reset all accumulated performance data and delete history file.
   */
  reset(): void {
    this.history = [];
    this.statsCache.clear();
    try {
      if (fs.existsSync(this.config.historyPath)) {
        fs.unlinkSync(this.config.historyPath);
      }
    } catch { /* ignore */ }
  }

  // ============================================
  // Internal helpers
  // ============================================

  private buildReasoning(
    model: ModelCandidate,
    profile: TaskProfile,
    score: number
  ): string {
    const parts: string[] = [`${profile.complexity} ${profile.category} task`];
    if (model.isLocal) {
      parts.push("routed to local model (zero cost)");
    } else if (model.costPer1kTokens === 0) {
      parts.push("routed to free cloud model");
    } else {
      parts.push(`routed to ${model.provider} (${model.costPer1kTokens} micro-cents/1k tokens)`);
    }
    if (profile.requiresTools) parts.push("tool-use required");
    if (profile.requiresVision) parts.push("vision required");
    parts.push(`quality tier ${model.qualityTier}/5`);
    parts.push(`score ${score.toFixed(1)}`);
    return parts.join(", ");
  }

  private updateStats(record: PerformanceRecord): void {
    const key = `${record.provider}::${record.model}`;
    const existing = this.statsCache.get(key);

    if (!existing) {
      const categoryScores: Partial<Record<TaskCategory, number>> = {};
      categoryScores[record.category] = record.success ? 1 : 0;
      this.statsCache.set(key, {
        provider: record.provider,
        model: record.model,
        totalRequests: 1,
        successRate: record.success ? 1 : 0,
        avgLatencyMs: record.latencyMs,
        avgTokenCount: record.tokenCount,
        lastUsed: record.timestamp,
        categoryScores,
      });
      return;
    }

    const n = existing.totalRequests;
    // EMA for per-category score, alpha=0.3
    const alpha = 0.3;
    const prevCat = existing.categoryScores[record.category] ?? existing.successRate;
    existing.categoryScores[record.category] =
      alpha * (record.success ? 1 : 0) + (1 - alpha) * prevCat;

    existing.totalRequests = n + 1;
    existing.successRate = (existing.successRate * n + (record.success ? 1 : 0)) / (n + 1);
    existing.avgLatencyMs = (existing.avgLatencyMs * n + record.latencyMs) / (n + 1);
    existing.avgTokenCount = (existing.avgTokenCount * n + record.tokenCount) / (n + 1);
    existing.lastUsed = record.timestamp;
    this.statsCache.set(key, existing);
  }

  private rebuildStats(): void {
    this.statsCache.clear();
    for (const record of this.history) {
      this.updateStats(record);
    }
  }

  private loadHistory(): PerformanceRecord[] {
    try {
      if (!fs.existsSync(this.config.historyPath)) return [];
      const raw = fs.readFileSync(this.config.historyPath, "utf-8").trim();
      if (!raw) return [];
      return raw
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as PerformanceRecord)
        .slice(-this.config.maxHistorySize);
    } catch {
      return [];
    }
  }

  private persistRecord(record: PerformanceRecord): void {
    try {
      const dir = path.dirname(this.config.historyPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(this.config.historyPath, JSON.stringify(record) + "\n");
    } catch {
      // Persistence is best-effort - never crash the caller
    }
  }
}

// ============================================
// Singleton helpers
// ============================================

let _instance: RouterOptimizer | null = null;

export function getRouterOptimizer(config?: RouterOptimizerConfig): RouterOptimizer {
  if (!_instance) _instance = new RouterOptimizer(config);
  return _instance;
}

export function resetRouterOptimizer(): void {
  _instance = null;
}

export default RouterOptimizer;
