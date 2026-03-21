/**
 * 8gent Ability Scorecard System
 *
 * Tracks 8 core abilities with measurable metrics:
 * memory, worktree, policy, evolution, healing, entrepreneurship, ast, browser
 *
 * Persists to ~/.8gent/scorecards/ as JSONL files (one per session).
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const ABILITIES = [
  "memory",
  "worktree",
  "policy",
  "evolution",
  "healing",
  "entrepreneurship",
  "ast",
  "browser",
] as const;

export type AbilityName = (typeof ABILITIES)[number];

/** Full scorecard — one score (0-100) per ability. */
export interface AbilityScorecard {
  memory: number;
  worktree: number;
  policy: number;
  evolution: number;
  healing: number;
  entrepreneurship: number;
  ast: number;
  browser: number;
}

/** Single recorded metric entry. */
export interface AbilityMetric {
  ability: AbilityName;
  score: number; // 0-100
  evidence: string;
  timestamp: string; // ISO 8601
}

/** Delta comparison between current average and baseline (first recorded). */
export interface BaselineDelta {
  ability: AbilityName;
  baseline: number;
  current: number;
  delta: number;
}

// ---------------------------------------------------------------------------
// Descriptions (for reference / display)
// ---------------------------------------------------------------------------

export const ABILITY_METRIC_DESCRIPTIONS: Record<AbilityName, string> = {
  memory: "Recall accuracy — did it remember what was stored? (% correct)",
  worktree:
    "Parallelization efficiency — tasks completed / time vs sequential estimate",
  policy: "Violation rate — policy violations found / total operations",
  evolution: "Improvement delta — score improvement across iterations",
  healing: "Recovery rate — successful reverts / total failures",
  entrepreneurship:
    "Opportunity hit rate — actionable finds / total scans",
  ast: "Blast radius accuracy — predicted impact files vs actual changed files",
  browser:
    "Research relevance — findings used in implementation / total searches",
};

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

const SCORECARDS_DIR = join(homedir(), ".8gent", "scorecards");

export class AbilityScorecardTracker {
  private metrics: AbilityMetric[] = [];
  private sessionId: string;
  private filePath: string;

  constructor(sessionId?: string) {
    this.sessionId =
      sessionId ?? new Date().toISOString().replace(/[:.]/g, "-");
    this.filePath = join(SCORECARDS_DIR, `${this.sessionId}.jsonl`);
    this.ensureDir();
    this.loadExisting();
  }

  // ---- public API ---------------------------------------------------------

  /** Record a single ability metric. Score is clamped to 0-100. */
  recordMetric(ability: AbilityName, score: number, evidence: string): void {
    const metric: AbilityMetric = {
      ability,
      score: clamp(score, 0, 100),
      evidence,
      timestamp: new Date().toISOString(),
    };
    this.metrics.push(metric);
    this.appendToFile(metric);
  }

  /** Current scorecard: average score per ability from this session. */
  getScorecard(): AbilityScorecard {
    const card: AbilityScorecard = {
      memory: 0,
      worktree: 0,
      policy: 0,
      evolution: 0,
      healing: 0,
      entrepreneurship: 0,
      ast: 0,
      browser: 0,
    };

    for (const ability of ABILITIES) {
      const scores = this.metrics
        .filter((m) => m.ability === ability)
        .map((m) => m.score);
      card[ability] = scores.length > 0 ? avg(scores) : 0;
    }

    return card;
  }

  /** Score history for a single ability in this session. */
  getHistory(ability: AbilityName): AbilityMetric[] {
    return this.metrics.filter((m) => m.ability === ability);
  }

  /**
   * Compare current session averages against the baseline.
   * Baseline = averages from the earliest JSONL file in the scorecards dir.
   * Returns null if no prior sessions exist.
   */
  compareToBaseline(): BaselineDelta[] | null {
    const baseline = this.loadBaseline();
    if (!baseline) return null;

    const current = this.getScorecard();
    return ABILITIES.map((ability) => ({
      ability,
      baseline: baseline[ability],
      current: current[ability],
      delta: round(current[ability] - baseline[ability]),
    }));
  }

  /** List all session files in the scorecards directory. */
  listSessions(): string[] {
    if (!existsSync(SCORECARDS_DIR)) return [];
    const { readdirSync } = require("fs") as typeof import("fs");
    return readdirSync(SCORECARDS_DIR)
      .filter((f: string) => f.endsWith(".jsonl"))
      .sort();
  }

  // ---- internals ----------------------------------------------------------

  private ensureDir(): void {
    if (!existsSync(SCORECARDS_DIR)) {
      mkdirSync(SCORECARDS_DIR, { recursive: true });
    }
  }

  private appendToFile(metric: AbilityMetric): void {
    const line = JSON.stringify(metric) + "\n";
    const { appendFileSync } = require("fs") as typeof import("fs");
    appendFileSync(this.filePath, line, "utf-8");
  }

  private loadExisting(): void {
    if (!existsSync(this.filePath)) return;
    const raw = readFileSync(this.filePath, "utf-8").trim();
    if (!raw) return;
    for (const line of raw.split("\n")) {
      try {
        this.metrics.push(JSON.parse(line) as AbilityMetric);
      } catch {
        // skip malformed lines
      }
    }
  }

  private loadBaseline(): AbilityScorecard | null {
    const sessions = this.listSessions();
    if (sessions.length === 0) return null;

    // Use the earliest file that isn't the current session
    const baselineFile = sessions.find((f) => f !== `${this.sessionId}.jsonl`);
    if (!baselineFile) return null;

    const path = join(SCORECARDS_DIR, baselineFile);
    const raw = readFileSync(path, "utf-8").trim();
    if (!raw) return null;

    const metrics: AbilityMetric[] = [];
    for (const line of raw.split("\n")) {
      try {
        metrics.push(JSON.parse(line) as AbilityMetric);
      } catch {
        // skip
      }
    }

    const card: AbilityScorecard = {
      memory: 0,
      worktree: 0,
      policy: 0,
      evolution: 0,
      healing: 0,
      entrepreneurship: 0,
      ast: 0,
      browser: 0,
    };

    for (const ability of ABILITIES) {
      const scores = metrics
        .filter((m) => m.ability === ability)
        .map((m) => m.score);
      card[ability] = scores.length > 0 ? avg(scores) : 0;
    }

    return card;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function avg(nums: number[]): number {
  return round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
