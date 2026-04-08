/**
 * Skill Evolution - tracks which approaches work best per task type
 * and automatically refines prompt strategies based on success/failure history.
 *
 * Concept extracted from OpenSpace/Self-Evolve (HKUDS), rebuilt from scratch.
 * Closes the gap between our static learned-skills and dynamic prompt evolution.
 */

import { getDb } from "./evolution-db.js";
import { getRecentReflections } from "./evolution-db.js";
import type { SessionReflection } from "./evolution-db.js";

// ============================================
// Types
// ============================================

export type TaskCategory =
  | "code-fix"
  | "code-gen"
  | "refactor"
  | "test-write"
  | "config"
  | "research"
  | "debug"
  | "unknown";

export interface ApproachRecord {
  id: string;
  category: TaskCategory;
  approach: string;       // The prompt strategy / approach description
  successCount: number;
  failureCount: number;
  totalTokens: number;    // Cumulative tokens used across all invocations
  avgSuccessRate: number;  // Computed: successCount / (successCount + failureCount)
  lastUsed: string;
  createdAt: string;
}

export interface EvolutionAdvice {
  category: TaskCategory;
  bestApproach: ApproachRecord | null;
  avoidApproaches: ApproachRecord[];
  promptPrefix: string;   // Ready-to-inject prompt segment
}

// ============================================
// DB Schema Extension
// ============================================

function ensureTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS approach_records (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      approach TEXT NOT NULL,
      success_count INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      last_used TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_approach_category ON approach_records(category);
  `);
}

let _initialized = false;
function init(): void {
  if (_initialized) return;
  ensureTable();
  _initialized = true;
}

// ============================================
// Task Classification
// ============================================

const CATEGORY_SIGNALS: Record<TaskCategory, string[]> = {
  "code-fix":   ["fix", "bug", "error", "broken", "crash", "failing", "issue", "wrong", "incorrect"],
  "code-gen":   ["create", "build", "implement", "add", "new", "generate", "write", "scaffold"],
  "refactor":   ["refactor", "clean", "restructure", "rename", "extract", "simplify", "move"],
  "test-write": ["test", "spec", "assert", "coverage", "unit", "integration", "e2e"],
  "config":     ["config", "setup", "install", "deploy", "env", "yaml", "toml", "json", "package"],
  "research":   ["research", "investigate", "explore", "understand", "analyze", "compare", "find"],
  "debug":      ["debug", "trace", "log", "inspect", "why", "cause", "root cause", "stack trace"],
  "unknown":    [],
};

/**
 * Classify a task description into a category based on keyword signals.
 * Returns the category with the highest signal overlap.
 */
export function classifyTask(description: string): TaskCategory {
  const words = description.toLowerCase().split(/\s+/);
  let bestCategory: TaskCategory = "unknown";
  let bestScore = 0;

  for (const [category, signals] of Object.entries(CATEGORY_SIGNALS) as [TaskCategory, string[]][]) {
    if (category === "unknown") continue;
    const score = signals.filter(s => words.some(w => w.includes(s))).length;
    if (score > bestScore) {
      bestScore = score;
      bestCategory = category;
    }
  }

  return bestCategory;
}

// ============================================
// Approach Recording
// ============================================

/**
 * Record a completed approach with its outcome.
 * If the same category+approach exists, updates stats. Otherwise creates new.
 */
export function recordApproach(
  category: TaskCategory,
  approach: string,
  success: boolean,
  tokensUsed: number = 0,
): ApproachRecord {
  init();
  const db = getDb();
  const now = new Date().toISOString();

  // Check for existing approach in this category (exact match on approach text)
  const existing = db.prepare(
    "SELECT * FROM approach_records WHERE category = ? AND approach = ?",
  ).get(category, approach) as any | null;

  if (existing) {
    const newSuccess = existing.success_count + (success ? 1 : 0);
    const newFailure = existing.failure_count + (success ? 0 : 1);
    const newTokens = existing.total_tokens + tokensUsed;

    db.prepare(`
      UPDATE approach_records
      SET success_count = ?, failure_count = ?, total_tokens = ?, last_used = ?
      WHERE id = ?
    `).run(newSuccess, newFailure, newTokens, now, existing.id);

    return deserialize({
      ...existing,
      success_count: newSuccess,
      failure_count: newFailure,
      total_tokens: newTokens,
      last_used: now,
    });
  }

  // New approach
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO approach_records (id, category, approach, success_count, failure_count, total_tokens, last_used, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, category, approach, success ? 1 : 0, success ? 0 : 1, tokensUsed, now, now);

  return {
    id,
    category,
    approach,
    successCount: success ? 1 : 0,
    failureCount: success ? 0 : 1,
    totalTokens: tokensUsed,
    avgSuccessRate: success ? 1 : 0,
    lastUsed: now,
    createdAt: now,
  };
}

// ============================================
// Evolution Advice
// ============================================

/**
 * Get evolution advice for a task. Returns the best approach for the category,
 * approaches to avoid, and a ready-to-inject prompt prefix.
 */
export function getAdvice(taskDescription: string): EvolutionAdvice {
  init();
  const category = classifyTask(taskDescription);
  const approaches = getApproachesByCategory(category);

  // Minimum 3 uses before we trust the data
  const trusted = approaches.filter(a => (a.successCount + a.failureCount) >= 3);

  // Best: highest success rate among trusted, break ties by total uses
  const sorted = [...trusted].sort((a, b) => {
    const diff = b.avgSuccessRate - a.avgSuccessRate;
    if (Math.abs(diff) < 0.01) return (b.successCount + b.failureCount) - (a.successCount + a.failureCount);
    return diff;
  });

  const bestApproach = sorted[0] || null;

  // Avoid: success rate below 40% with enough data
  const avoidApproaches = trusted.filter(a => a.avgSuccessRate < 0.4);

  // Build prompt prefix
  let promptPrefix = "";
  if (bestApproach) {
    promptPrefix += `## Evolved approach for ${category} tasks\n`;
    promptPrefix += `Preferred strategy (${(bestApproach.avgSuccessRate * 100).toFixed(0)}% success rate, ${bestApproach.successCount + bestApproach.failureCount} uses):\n`;
    promptPrefix += `${bestApproach.approach}\n`;
  }
  if (avoidApproaches.length > 0) {
    promptPrefix += `\nAvoid these approaches:\n`;
    for (const a of avoidApproaches.slice(0, 3)) {
      promptPrefix += `- ${a.approach} (${(a.avgSuccessRate * 100).toFixed(0)}% success rate)\n`;
    }
  }

  return { category, bestApproach, avoidApproaches, promptPrefix };
}

/**
 * Get all recorded approaches for a category, sorted by success rate descending.
 */
export function getApproachesByCategory(category: TaskCategory): ApproachRecord[] {
  init();
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM approach_records WHERE category = ? ORDER BY CAST(success_count AS REAL) / MAX(success_count + failure_count, 1) DESC",
  ).all(category) as any[];
  return rows.map(deserialize);
}

// ============================================
// Reflection Integration
// ============================================

/**
 * Distill recent reflections into approach records.
 * Call this periodically (e.g. end of session) to feed reflection data
 * into the evolution system.
 */
export function evolveFromReflections(limit: number = 10): number {
  init();
  const reflections = getRecentReflections(limit);
  let evolved = 0;

  for (const r of reflections) {
    const category = inferCategoryFromReflection(r);
    if (category === "unknown") continue;

    // Each observed pattern becomes an approach record
    for (const pattern of r.patternsObserved) {
      recordApproach(category, pattern, r.successRate >= 0.7);
      evolved++;
    }
  }

  return evolved;
}

/**
 * Infer task category from a session reflection's tools and patterns.
 */
function inferCategoryFromReflection(r: SessionReflection): TaskCategory {
  const allText = [...r.toolsUsed, ...r.patternsObserved, ...r.errorsEncountered].join(" ");
  return classifyTask(allText);
}

// ============================================
// Helpers
// ============================================

function deserialize(row: any): ApproachRecord {
  const total = row.success_count + row.failure_count;
  return {
    id: row.id,
    category: row.category as TaskCategory,
    approach: row.approach,
    successCount: row.success_count,
    failureCount: row.failure_count,
    totalTokens: row.total_tokens,
    avgSuccessRate: total > 0 ? row.success_count / total : 0,
    lastUsed: row.last_used,
    createdAt: row.created_at,
  };
}
