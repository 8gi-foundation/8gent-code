/**
 * meta-optimizer.ts — Tracks and optimizes all tunable autoresearch parameters
 *
 * Beyond system prompt mutations, this optimizes: few-shot selections,
 * model routing, grading weights, and temperature sweeps.
 *
 * Pure heuristics — no ML. Persists state to JSON for resumability.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { BenchmarkCategory } from "../types";

// ── Interfaces ──────────────────────────────────────────────────────

export interface GradingWeights {
  execution: number;
  keyword: number;
}

export interface MetaConfig {
  systemPromptMutations: string[];
  fewShotSelections: Record<string, string[]>;
  gradingWeights: GradingWeights;
  temperatures: number[];
  modelPriority: Record<string, string[]>;
}

interface Trial {
  config: MetaConfig;
  category: string;
  avgScore: number;
  scores: Record<string, number>;
  timestamp: string;
}

interface MetaState {
  trials: Trial[];
  bestPerCategory: Record<string, { config: MetaConfig; avgScore: number }>;
}

// ── Defaults ────────────────────────────────────────────────────────

const DEFAULT_MODELS = [
  "ollama::qwen3.5:latest",
  "ollama::devstral:latest",
  "ollama::qwen3:14b",
  "openrouter::google/gemini-2.5-flash:free",
];

const DEFAULT_TEMPERATURES = [0.3, 0.5, 0.7];

const DEFAULT_GRADING: GradingWeights = { execution: 0.7, keyword: 0.3 };

const ALL_CATEGORIES: BenchmarkCategory[] = [
  "bug-fixing",
  "file-manipulation",
  "feature-implementation",
  "fullstack",
  "agentic",
  "ui-design",
  "battle-test",
];

const DEFAULT_CONFIG: MetaConfig = {
  systemPromptMutations: [],
  fewShotSelections: Object.fromEntries(ALL_CATEGORIES.map((c) => [c, ["default"]])),
  gradingWeights: { ...DEFAULT_GRADING },
  temperatures: [...DEFAULT_TEMPERATURES],
  modelPriority: Object.fromEntries(ALL_CATEGORIES.map((c) => [c, [...DEFAULT_MODELS]])),
};

// ── MetaOptimizer ───────────────────────────────────────────────────

export class MetaOptimizer {
  private state: MetaState;
  private stateFile: string;

  constructor(stateFile: string) {
    this.stateFile = stateFile;
    this.state = this.load();
  }

  // ── Persistence ─────────────────────────────────────────────────

  private load(): MetaState {
    if (existsSync(this.stateFile)) {
      try {
        return JSON.parse(readFileSync(this.stateFile, "utf-8"));
      } catch {
        // corrupted file — start fresh
      }
    }
    return { trials: [], bestPerCategory: {} };
  }

  private save(): void {
    writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
  }

  // ── Public API ──────────────────────────────────────────────────

  getCurrentConfig(): MetaConfig {
    // Return best-known config merged across categories, or default
    if (this.state.trials.length === 0) return structuredClone(DEFAULT_CONFIG);

    const best = this.state.bestPerCategory;
    const config = structuredClone(DEFAULT_CONFIG);

    // Merge best-known model priorities per category
    for (const cat of ALL_CATEGORIES) {
      if (best[cat]?.config.modelPriority[cat]) {
        config.modelPriority[cat] = best[cat].config.modelPriority[cat];
      }
      if (best[cat]?.config.fewShotSelections[cat]) {
        config.fewShotSelections[cat] = best[cat].config.fewShotSelections[cat];
      }
    }

    // Use the grading weights from the overall best trial
    const bestTrial = this.state.trials.reduce((a, b) => (a.avgScore >= b.avgScore ? a : b));
    config.gradingWeights = { ...bestTrial.config.gradingWeights };
    config.temperatures = [...bestTrial.config.temperatures];
    config.systemPromptMutations = [...bestTrial.config.systemPromptMutations];

    return config;
  }

  recordResult(
    config: MetaConfig,
    category: string,
    avgScore: number,
    benchmarkScores: Record<string, number>,
  ): void {
    const trial: Trial = {
      config: structuredClone(config),
      category,
      avgScore,
      scores: { ...benchmarkScores },
      timestamp: new Date().toISOString(),
    };

    this.state.trials.push(trial);

    // Update best-per-category
    const prev = this.state.bestPerCategory[category];
    if (!prev || avgScore > prev.avgScore) {
      this.state.bestPerCategory[category] = { config: structuredClone(config), avgScore };
    }

    this.save();
  }

  suggestNextConfig(): MetaConfig {
    const base = this.getCurrentConfig();

    if (this.state.trials.length < 2) return base;

    // ── Model priority: promote models that scored well per category
    for (const cat of ALL_CATEGORIES) {
      const catTrials = this.state.trials.filter((t) => t.category === cat);
      if (catTrials.length < 2) continue;

      const modelScores = this.aggregateModelScores(catTrials);
      if (modelScores.length > 0) {
        base.modelPriority[cat] = modelScores.map((m) => m.model);
      }
    }

    // ── Grading weights: trend toward what works
    const weightTrend = this.analyzeWeightTrend();
    if (weightTrend !== null) {
      // Nudge 5% toward the better-performing weight split
      const nudge = 0.05 * Math.sign(weightTrend);
      const newExec = clamp(base.gradingWeights.execution + nudge, 0.4, 0.9);
      base.gradingWeights = { execution: newExec, keyword: round2(1 - newExec) };
    }

    // ── Temperature: narrow sweep toward best-performing temps
    const bestTemps = this.analyzeBestTemperatures();
    if (bestTemps.length > 0) {
      // Keep best temps + add one neighbor for exploration
      const temps = new Set(bestTemps);
      for (const t of bestTemps) {
        if (t - 0.1 >= 0.1) temps.add(round2(t - 0.1));
        if (t + 0.1 <= 1.0) temps.add(round2(t + 0.1));
      }
      base.temperatures = [...temps].sort((a, b) => a - b).slice(0, 5);
    }

    // ── Few-shot: keep selections from best-performing configs
    // (already handled by getCurrentConfig pulling from bestPerCategory)

    return base;
  }

  getInsights(): string[] {
    const insights: string[] = [];
    const trials = this.state.trials;

    if (trials.length === 0) {
      insights.push("No trials recorded yet. Run some benchmarks first.");
      return insights;
    }

    insights.push(`Total trials: ${trials.length}`);

    // Best per category
    for (const [cat, best] of Object.entries(this.state.bestPerCategory)) {
      insights.push(`Best ${cat}: ${best.avgScore.toFixed(1)} avg`);
    }

    // Model rankings per category
    for (const cat of ALL_CATEGORIES) {
      const catTrials = trials.filter((t) => t.category === cat);
      if (catTrials.length < 2) continue;

      const modelScores = this.aggregateModelScores(catTrials);
      if (modelScores.length > 0) {
        const ranked = modelScores.map((m) => `${shortModel(m.model)}(${m.avgScore.toFixed(0)})`).join(" > ");
        insights.push(`Model rank [${cat}]: ${ranked}`);
      }
    }

    // Grading weight trend
    const trend = this.analyzeWeightTrend();
    if (trend !== null) {
      const dir = trend > 0 ? "more execution weight" : "more keyword weight";
      insights.push(`Grading weight trend: ${dir} correlates with better scores`);
    }

    // Temperature insights
    const bestTemps = this.analyzeBestTemperatures();
    if (bestTemps.length > 0) {
      insights.push(`Best temperatures: ${bestTemps.join(", ")}`);
    }

    // Score trajectory
    if (trials.length >= 3) {
      const recent3 = trials.slice(-3).map((t) => t.avgScore);
      const earlier3 = trials.slice(-6, -3).map((t) => t.avgScore);
      if (earlier3.length === 3) {
        const recentAvg = avg(recent3);
        const earlierAvg = avg(earlier3);
        const delta = recentAvg - earlierAvg;
        if (Math.abs(delta) > 1) {
          insights.push(
            `Trend: ${delta > 0 ? "improving" : "regressing"} (${delta > 0 ? "+" : ""}${delta.toFixed(1)} avg over last 6 trials)`,
          );
        } else {
          insights.push("Trend: plateaued — consider larger config changes");
        }
      }
    }

    return insights;
  }

  // ── Analysis helpers ────────────────────────────────────────────

  private aggregateModelScores(catTrials: Trial[]): { model: string; avgScore: number }[] {
    // Extract which model was first-priority for these trials and correlate with score
    const modelScoreMap = new Map<string, number[]>();

    for (const trial of catTrials) {
      const primaryModel = trial.config.modelPriority[trial.category]?.[0];
      if (!primaryModel) continue;
      const arr = modelScoreMap.get(primaryModel) ?? [];
      arr.push(trial.avgScore);
      modelScoreMap.set(primaryModel, arr);
    }

    return [...modelScoreMap.entries()]
      .map(([model, scores]) => ({ model, avgScore: avg(scores) }))
      .sort((a, b) => b.avgScore - a.avgScore);
  }

  private analyzeWeightTrend(): number | null {
    // Compare trials with higher exec weight vs lower exec weight
    const trials = this.state.trials;
    if (trials.length < 4) return null;

    const median = 0.7; // default split
    const highExec = trials.filter((t) => t.config.gradingWeights.execution > median);
    const lowExec = trials.filter((t) => t.config.gradingWeights.execution <= median);

    if (highExec.length < 2 || lowExec.length < 2) return null;

    const highAvg = avg(highExec.map((t) => t.avgScore));
    const lowAvg = avg(lowExec.map((t) => t.avgScore));
    const diff = highAvg - lowAvg;

    // Only report if meaningful difference (>3 points)
    return Math.abs(diff) > 3 ? diff : null;
  }

  private analyzeBestTemperatures(): number[] {
    const trials = this.state.trials;
    if (trials.length < 3) return [];

    // For each temperature that appeared in configs, track avg score
    const tempScores = new Map<number, number[]>();
    for (const trial of trials) {
      for (const t of trial.config.temperatures) {
        const arr = tempScores.get(t) ?? [];
        arr.push(trial.avgScore);
        tempScores.set(t, arr);
      }
    }

    // Return temps that are above the global average
    const globalAvg = avg(trials.map((t) => t.avgScore));
    return [...tempScores.entries()]
      .filter(([, scores]) => scores.length >= 2 && avg(scores) > globalAvg)
      .sort((a, b) => avg(b[1]) - avg(a[1]))
      .map(([temp]) => temp)
      .slice(0, 3);
  }
}

// ── Utilities ───────────────────────────────────────────────────────

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function shortModel(model: string): string {
  // "ollama::qwen3.5:latest" -> "qwen3.5"
  return model.replace(/^(ollama|openrouter)::/, "").replace(/:latest$/, "").split("/").pop() ?? model;
}
