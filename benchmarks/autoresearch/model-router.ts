/**
 * model-router.ts — Experience-Based Model Router
 *
 * Routes benchmarks to the best-performing model based on past results,
 * not a fixed fallback chain. Learns from every run.
 *
 * How it works:
 * 1. After each benchmark run, record (model, domain, benchmarkId, score)
 * 2. When routing a new run, look up the best model for that domain
 * 3. Try the best-known model first, then fall back to untried models
 * 4. Cold start: round-robin until we have data
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const EXPERIENCE_FILE = join(ROOT, "autoresearch", "model-experience.json");

interface ModelScore {
  model: string;
  score: number;
  benchmarkId: string;
  timestamp: number;
}

interface ExperienceDB {
  /** domain -> array of (model, score) records */
  byDomain: Record<string, ModelScore[]>;
  /** benchmarkId -> array of (model, score) records */
  byBenchmark: Record<string, ModelScore[]>;
  /** model -> total runs */
  runCounts: Record<string, number>;
  /** last updated */
  updatedAt: string;
}

function loadExperience(): ExperienceDB {
  try {
    if (existsSync(EXPERIENCE_FILE)) {
      return JSON.parse(readFileSync(EXPERIENCE_FILE, "utf-8"));
    }
  } catch {}
  return { byDomain: {}, byBenchmark: {}, runCounts: {}, updatedAt: "" };
}

function saveExperience(db: ExperienceDB): void {
  db.updatedAt = new Date().toISOString();
  writeFileSync(EXPERIENCE_FILE, JSON.stringify(db, null, 2));
}

/**
 * Record a model's performance on a benchmark.
 */
export function recordResult(
  model: string,
  domain: string,
  benchmarkId: string,
  score: number
): void {
  const db = loadExperience();
  const entry: ModelScore = { model, score, benchmarkId, timestamp: Date.now() };

  // Store by domain
  if (!db.byDomain[domain]) db.byDomain[domain] = [];
  db.byDomain[domain].push(entry);
  // Keep last 20 per domain to avoid unbounded growth
  if (db.byDomain[domain].length > 20) {
    db.byDomain[domain] = db.byDomain[domain].slice(-20);
  }

  // Store by benchmark
  if (!db.byBenchmark[benchmarkId]) db.byBenchmark[benchmarkId] = [];
  db.byBenchmark[benchmarkId].push(entry);
  if (db.byBenchmark[benchmarkId].length > 10) {
    db.byBenchmark[benchmarkId] = db.byBenchmark[benchmarkId].slice(-10);
  }

  // Track run count
  db.runCounts[model] = (db.runCounts[model] ?? 0) + 1;

  saveExperience(db);
}

/**
 * Get the best model ordering for a given benchmark.
 * Returns models sorted by: best average score for this domain,
 * with the specific benchmark's best model weighted higher.
 */
export function getModelOrder(
  availableModels: string[],
  domain: string,
  benchmarkId: string
): string[] {
  const db = loadExperience();

  // Calculate average score per model for this domain
  const domainScores: Record<string, { total: number; count: number }> = {};
  for (const entry of db.byDomain[domain] ?? []) {
    if (!availableModels.includes(entry.model)) continue;
    if (!domainScores[entry.model]) domainScores[entry.model] = { total: 0, count: 0 };
    domainScores[entry.model].total += entry.score;
    domainScores[entry.model].count += 1;
  }

  // Calculate average score per model for this specific benchmark (weighted 2x)
  const benchScores: Record<string, { total: number; count: number }> = {};
  for (const entry of db.byBenchmark[benchmarkId] ?? []) {
    if (!availableModels.includes(entry.model)) continue;
    if (!benchScores[entry.model]) benchScores[entry.model] = { total: 0, count: 0 };
    benchScores[entry.model].total += entry.score;
    benchScores[entry.model].count += 1;
  }

  // Combined score: benchmark-specific avg * 2 + domain avg * 1
  const combined: Record<string, number> = {};
  for (const model of availableModels) {
    const domainAvg = domainScores[model]
      ? domainScores[model].total / domainScores[model].count
      : -1; // untried = -1
    const benchAvg = benchScores[model]
      ? benchScores[model].total / benchScores[model].count
      : -1;

    if (domainAvg === -1 && benchAvg === -1) {
      // Never tried this model for this domain — give it exploration priority
      // Less-used models get higher exploration score
      const runs = db.runCounts[model] ?? 0;
      combined[model] = -0.5 + (1 / (runs + 1)); // between -0.5 and 0.5
    } else {
      const dScore = domainAvg >= 0 ? domainAvg : 0;
      const bScore = benchAvg >= 0 ? benchAvg : 0;
      const weights = (benchAvg >= 0 ? 2 : 0) + (domainAvg >= 0 ? 1 : 0);
      combined[model] = weights > 0
        ? ((bScore * 2) + dScore) / Math.max(weights, 1)
        : 0;
    }
  }

  // Sort descending by combined score
  return [...availableModels].sort((a, b) => combined[b] - combined[a]);
}

/**
 * Get a summary of what we know about each model.
 */
export function getExperienceSummary(): string {
  const db = loadExperience();

  const lines: string[] = ["Model Experience Summary", "═".repeat(50)];

  // Per-domain best
  for (const [domain, entries] of Object.entries(db.byDomain)) {
    const modelAvgs: Record<string, { total: number; count: number }> = {};
    for (const e of entries) {
      if (!modelAvgs[e.model]) modelAvgs[e.model] = { total: 0, count: 0 };
      modelAvgs[e.model].total += e.score;
      modelAvgs[e.model].count += 1;
    }

    const sorted = Object.entries(modelAvgs)
      .map(([m, s]) => ({ model: m, avg: Math.round(s.total / s.count), runs: s.count }))
      .sort((a, b) => b.avg - a.avg);

    const best = sorted[0];
    if (best) {
      lines.push(`  ${domain}: ${best.model} (avg ${best.avg}, ${best.runs} runs)`);
    }
  }

  // Run counts
  lines.push("", "Run Counts:");
  for (const [model, count] of Object.entries(db.runCounts)) {
    lines.push(`  ${model}: ${count} runs`);
  }

  return lines.join("\n");
}
