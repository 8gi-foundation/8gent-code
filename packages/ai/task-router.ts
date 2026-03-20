/**
 * 8gent AI - Task Router
 *
 * Classifies incoming tasks and routes them to the best model.
 * Uses a fast local model (0.5B) to classify, then delegates to
 * the appropriate specialist model.
 *
 * Task categories:
 *   - code:      Write/edit/debug code → code-specialized model
 *   - reasoning: Complex logic, planning, architecture → reasoning model
 *   - simple:    Quick answers, explanations, chat → fast small model
 *   - creative:  Writing, naming, brainstorming → general model
 *
 * The router learns from experience — models that perform well on
 * certain task types get prioritized.
 */

import { generateObject } from "ai";
import { z } from "zod";
import { createModel, type ProviderConfig, type ProviderName } from "./providers";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

// ============================================
// Types
// ============================================

export type TaskCategory = "code" | "reasoning" | "simple" | "creative";

export interface RouteDecision {
  category: TaskCategory;
  confidence: number;
  model: string;
  reasoning: string;
}

export interface ModelSlot {
  model: string;
  provider: ProviderName;
  apiKey?: string;
}

export interface RouterConfig {
  /** Enable/disable routing (false = always use default model) */
  enabled: boolean;
  /** Model used for classification (should be tiny and fast) */
  classifierModel: string;
  /** Provider for classifier */
  classifierProvider: ProviderName;
  /** Model assignments per task category */
  slots: Record<TaskCategory, ModelSlot>;
  /** Confidence threshold — below this, use default model instead */
  confidenceThreshold: number;
  /** Default model when routing is disabled or low confidence */
  defaultModel: ModelSlot;
}

// ============================================
// Default Config
// ============================================

const CONFIG_DIR = join(process.env.HOME || "~", ".8gent");
const ROUTER_CONFIG_PATH = join(CONFIG_DIR, "router.json");
const ROUTER_STATS_PATH = join(CONFIG_DIR, "router-stats.json");

const DEFAULT_CONFIG: RouterConfig = {
  enabled: true,
  classifierModel: "qwen3.5:latest",
  classifierProvider: "ollama",
  confidenceThreshold: 0.6,
  slots: {
    code: { model: "eight:latest", provider: "ollama" },
    reasoning: { model: "eight-1-q-14b:latest", provider: "ollama" },
    simple: { model: "qwen3.5:latest", provider: "ollama" },
    creative: { model: "eight:latest", provider: "ollama" },
  },
  defaultModel: { model: "eight:latest", provider: "ollama" },
};

// ============================================
// Config persistence
// ============================================

export function loadRouterConfig(): RouterConfig {
  try {
    if (existsSync(ROUTER_CONFIG_PATH)) {
      const raw = JSON.parse(readFileSync(ROUTER_CONFIG_PATH, "utf-8"));
      return { ...DEFAULT_CONFIG, ...raw, slots: { ...DEFAULT_CONFIG.slots, ...raw.slots } };
    }
  } catch { /* defaults */ }
  return { ...DEFAULT_CONFIG };
}

export function saveRouterConfig(config: RouterConfig): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(ROUTER_CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ============================================
// Stats tracking
// ============================================

interface RouterStats {
  totalRouted: number;
  byCategory: Record<TaskCategory, number>;
  byModel: Record<string, { routed: number; avgLatencyMs: number }>;
  lastUpdated: string;
}

function loadStats(): RouterStats {
  try {
    if (existsSync(ROUTER_STATS_PATH)) {
      return JSON.parse(readFileSync(ROUTER_STATS_PATH, "utf-8"));
    }
  } catch {}
  return {
    totalRouted: 0,
    byCategory: { code: 0, reasoning: 0, simple: 0, creative: 0 },
    byModel: {},
    lastUpdated: "",
  };
}

function saveStats(stats: RouterStats): void {
  stats.lastUpdated = new Date().toISOString();
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(ROUTER_STATS_PATH, JSON.stringify(stats, null, 2));
}

export function recordRouting(category: TaskCategory, model: string, latencyMs: number): void {
  const stats = loadStats();
  stats.totalRouted++;
  stats.byCategory[category] = (stats.byCategory[category] ?? 0) + 1;
  if (!stats.byModel[model]) stats.byModel[model] = { routed: 0, avgLatencyMs: 0 };
  const m = stats.byModel[model];
  m.avgLatencyMs = (m.avgLatencyMs * m.routed + latencyMs) / (m.routed + 1);
  m.routed++;
  saveStats(stats);
}

export function getRouterStats(): RouterStats {
  return loadStats();
}

// ============================================
// Classification Schema
// ============================================

const ClassificationSchema = z.object({
  category: z.enum(["code", "reasoning", "simple", "creative"]).describe(
    "Task category: code (write/edit/debug code, fix errors, implement features), " +
    "reasoning (complex logic, planning, architecture, multi-step analysis), " +
    "simple (quick answers, explanations, short chat, factual questions), " +
    "creative (writing, naming, brainstorming, design ideas)"
  ),
  confidence: z.number().min(0).max(1).describe("How confident you are in this classification (0-1)"),
  reasoning: z.string().describe("One sentence explaining why this category"),
});

// ============================================
// Task Router
// ============================================

export class TaskRouter {
  private config: RouterConfig;

  constructor(config?: Partial<RouterConfig>) {
    this.config = config
      ? { ...loadRouterConfig(), ...config }
      : loadRouterConfig();
  }

  /** Classify a task using the small classifier model */
  async classify(prompt: string): Promise<{ category: TaskCategory; confidence: number; reasoning: string }> {
    const classifierConfig: ProviderConfig = {
      name: this.config.classifierProvider,
      model: this.config.classifierModel,
    };

    const model = createModel(classifierConfig);

    const { object } = await generateObject({
      model,
      schema: ClassificationSchema,
      prompt: `Classify this user task into exactly one category.\n\nTask: ${prompt.slice(0, 500)}`,
      maxTokens: 100,
    });

    return {
      category: object.category,
      confidence: object.confidence,
      reasoning: object.reasoning,
    };
  }

  /** Route a task to the best model */
  async route(prompt: string): Promise<RouteDecision> {
    if (!this.config.enabled) {
      return {
        category: "simple",
        confidence: 1,
        model: this.config.defaultModel.model,
        reasoning: "Routing disabled — using default model",
      };
    }

    const start = Date.now();

    try {
      const classification = await this.classify(prompt);

      // If confidence is too low, use default
      if (classification.confidence < this.config.confidenceThreshold) {
        const decision: RouteDecision = {
          ...classification,
          model: this.config.defaultModel.model,
          reasoning: `Low confidence (${classification.confidence.toFixed(2)}) — using default`,
        };
        recordRouting(classification.category, decision.model, Date.now() - start);
        return decision;
      }

      const slot = this.config.slots[classification.category];
      const decision: RouteDecision = {
        ...classification,
        model: slot.model,
      };

      recordRouting(classification.category, decision.model, Date.now() - start);
      return decision;
    } catch {
      // Classification failed — use default
      return {
        category: "simple",
        confidence: 0,
        model: this.config.defaultModel.model,
        reasoning: "Classification failed — using default model",
      };
    }
  }

  /** Get the ProviderConfig for a routed model */
  getProviderConfig(decision: RouteDecision): ProviderConfig {
    const slot = this.config.slots[decision.category];
    if (slot && slot.model === decision.model) {
      return {
        name: slot.provider,
        model: slot.model,
        apiKey: slot.apiKey,
      };
    }
    return {
      name: this.config.defaultModel.provider,
      model: this.config.defaultModel.model,
      apiKey: this.config.defaultModel.apiKey,
    };
  }

  /** Update a slot assignment */
  setSlot(category: TaskCategory, slot: ModelSlot): void {
    this.config.slots[category] = slot;
    saveRouterConfig(this.config);
  }

  /** Update router config */
  setConfig(overrides: Partial<RouterConfig>): RouterConfig {
    this.config = { ...this.config, ...overrides };
    if (overrides.slots) {
      this.config.slots = { ...this.config.slots, ...overrides.slots };
    }
    saveRouterConfig(this.config);
    return { ...this.config };
  }

  /** Get current config */
  getConfig(): RouterConfig {
    return { ...this.config };
  }

  /**
   * Promote a new model into the router.
   * Called by the kernel's production loop when a fine-tuned checkpoint
   * passes validation benchmarks.
   *
   * @param modelTag - Ollama model tag (e.g., "eight-1.1-q3:14b")
   * @param categories - Which slots to update (default: all except simple)
   * @param provider - Provider name (default: "ollama")
   */
  promote(
    modelTag: string,
    categories: TaskCategory[] = ["code", "reasoning", "creative"],
    provider: ProviderName = "ollama"
  ): void {
    for (const cat of categories) {
      this.config.slots[cat] = { model: modelTag, provider };
    }
    this.config.defaultModel = { model: modelTag, provider };
    saveRouterConfig(this.config);
  }

  /**
   * Discover available Ollama models and auto-assign slots
   * based on model names and sizes.
   */
  async autoAssign(): Promise<string[]> {
    const changes: string[] = [];

    try {
      const res = await fetch("http://localhost:11434/api/tags", {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return changes;

      const data = await res.json() as { models?: Array<{ name: string; size: number }> };
      const models = data.models ?? [];

      // Find the best Eight model (largest/newest)
      const eightModels = models
        .filter((m) => m.name.startsWith("eight"))
        .sort((a, b) => b.size - a.size);

      if (eightModels.length > 0) {
        const best = eightModels[0].name;
        const small = eightModels.length > 1 ? eightModels[eightModels.length - 1].name : best;

        // Big Eight → reasoning, code
        if (this.config.slots.reasoning.model !== best) {
          this.config.slots.reasoning = { model: best, provider: "ollama" };
          changes.push(`reasoning → ${best}`);
        }
        if (this.config.slots.code.model !== best && this.config.slots.code.model !== small) {
          this.config.slots.code = { model: small, provider: "ollama" };
          changes.push(`code → ${small}`);
        }
        // Default to the smaller Eight
        this.config.defaultModel = { model: small, provider: "ollama" };
        changes.push(`default → ${small}`);
      }

      // Find a fast model for simple tasks
      const fastModels = models
        .filter((m) => m.name.includes("qwen3.5") || m.name.includes("phi") || m.name.includes("gemma"))
        .sort((a, b) => a.size - b.size);

      if (fastModels.length > 0) {
        const fast = fastModels[0].name;
        if (this.config.slots.simple.model !== fast) {
          this.config.slots.simple = { model: fast, provider: "ollama" };
          changes.push(`simple → ${fast}`);
        }
        // Also use as classifier
        this.config.classifierModel = fast;
        changes.push(`classifier → ${fast}`);
      }

      if (changes.length > 0) saveRouterConfig(this.config);
    } catch { /* Ollama not available */ }

    return changes;
  }
}

// ============================================
// Singleton
// ============================================

let instance: TaskRouter | null = null;

export function getTaskRouter(): TaskRouter {
  if (!instance) {
    instance = new TaskRouter();
  }
  return instance;
}
