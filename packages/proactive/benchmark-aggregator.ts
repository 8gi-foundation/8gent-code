/**
 * Benchmark Aggregator
 *
 * Reads all benchmark JSON results from benchmarks/, aggregates into a single
 * dashboard report with trends, best/worst scores, and improvement suggestions.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";

// --- Types ---

interface BenchmarkEntry {
  id: string;
  score: number;
  category: string;
  model: string;
  timestamp: number;
  tokens?: number;
  durationMs?: number;
}

export interface AggregatedReport {
  generatedAt: string;
  totalEntries: number;
  overallAvg: number;
  bestScore: { id: string; score: number; category: string };
  worstScore: { id: string; score: number; category: string };
  byCategory: Record<string, { avg: number; count: number; best: number; worst: number }>;
  trends: { category: string; direction: "improving" | "declining" | "stable"; delta: number }[];
  suggestions: string[];
}

// --- Helpers ---

function mean(nums: number[]): number {
  if (!nums.length) return 0;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

/** Extract flat entries from a suite result (benchmarks/results/*.json) */
function parseSuiteResult(data: any): BenchmarkEntry[] {
  if (!data.results || !Array.isArray(data.results)) return [];
  return data.results.map((r: any) => ({
    id: r.benchmarkId ?? "unknown",
    score: r.scores?.overall ?? 0,
    category: Object.keys(data.categoryScores ?? {})[0] ?? "unknown",
    model: data.model ?? "unknown",
    timestamp: r.timing?.startTime ?? (Date.parse(data.timestamp) || 0),
    tokens: r.tokens?.actual,
    durationMs: r.timing?.duration,
  }));
}

/** Extract flat entries from loop-state / autoresearch-report JSON */
function parseLoopState(data: any): BenchmarkEntry[] {
  const history: any[] = data.history ?? [];
  const category = data.config?.category ?? data.category ?? "unknown";
  const entries: BenchmarkEntry[] = [];
  for (const iter of history) {
    const scores: Record<string, number> = iter.scores ?? {};
    const ts = Date.parse(iter.timestamp) || 0;
    for (const [id, score] of Object.entries(scores)) {
      entries.push({
        id,
        score: score as number,
        category,
        model: data.config?.models?.[0] ?? "unknown",
        timestamp: ts,
        tokens: iter.tokens?.[id],
        durationMs: iter.durations?.[id],
      });
    }
  }
  return entries;
}

/** Extract flat entries from model-experience.json */
function parseModelExperience(data: any): BenchmarkEntry[] {
  const entries: BenchmarkEntry[] = [];
  for (const [domain, records] of Object.entries(data.byDomain ?? {})) {
    for (const r of records as any[]) {
      entries.push({
        id: r.benchmarkId ?? "unknown",
        score: r.score ?? 0,
        category: domain,
        model: r.model ?? "unknown",
        timestamp: r.timestamp ?? 0,
      });
    }
  }
  return entries;
}

/** Recursively collect all .json files under a directory */
async function collectJsonFiles(dir: string): Promise<string[]> {
  const paths: string[] = [];
  const items = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const item of items) {
    const full = join(dir, item.name);
    if (item.isDirectory()) paths.push(...(await collectJsonFiles(full)));
    else if (item.name.endsWith(".json")) paths.push(full);
  }
  return paths;
}

// --- Main ---

export async function aggregateBenchmarks(
  benchmarksDir: string = join(import.meta.dir, "../../benchmarks")
): Promise<AggregatedReport> {
  const files = await collectJsonFiles(benchmarksDir);
  const allEntries: BenchmarkEntry[] = [];

  for (const file of files) {
    try {
      const data = await Bun.file(file).json();
      if (data.results && Array.isArray(data.results)) allEntries.push(...parseSuiteResult(data));
      else if (data.history && Array.isArray(data.history)) allEntries.push(...parseLoopState(data));
      else if (data.byDomain) allEntries.push(...parseModelExperience(data));
    } catch { /* skip unparseable files */ }
  }

  if (!allEntries.length) {
    return { generatedAt: new Date().toISOString(), totalEntries: 0, overallAvg: 0, bestScore: { id: "-", score: 0, category: "-" }, worstScore: { id: "-", score: 0, category: "-" }, byCategory: {}, trends: [], suggestions: ["No benchmark data found."] };
  }

  const sorted = [...allEntries].sort((a, b) => b.score - a.score);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];

  // Group by category
  const byCat: Record<string, BenchmarkEntry[]> = {};
  for (const e of allEntries) (byCat[e.category] ??= []).push(e);

  const byCategory: AggregatedReport["byCategory"] = {};
  for (const [cat, entries] of Object.entries(byCat)) {
    const scores = entries.map((e) => e.score);
    byCategory[cat] = { avg: mean(scores), count: scores.length, best: Math.max(...scores), worst: Math.min(...scores) };
  }

  // Trends - compare first half vs second half of time-sorted entries per category
  const trends: AggregatedReport["trends"] = [];
  for (const [cat, entries] of Object.entries(byCat)) {
    if (entries.length < 4) continue;
    const timeSorted = [...entries].sort((a, b) => a.timestamp - b.timestamp);
    const mid = Math.floor(timeSorted.length / 2);
    const earlyAvg = mean(timeSorted.slice(0, mid).map((e) => e.score));
    const lateAvg = mean(timeSorted.slice(mid).map((e) => e.score));
    const delta = lateAvg - earlyAvg;
    trends.push({ category: cat, direction: delta > 3 ? "improving" : delta < -3 ? "declining" : "stable", delta });
  }

  // Suggestions
  const suggestions: string[] = [];
  for (const [cat, stats] of Object.entries(byCategory)) {
    if (stats.avg < 50) suggestions.push(`[${cat}] Average score ${stats.avg} is below 50 - needs focused improvement.`);
    if (stats.worst < 30) suggestions.push(`[${cat}] Has scores below 30 - review failing benchmarks for regressions.`);
  }
  const declining = trends.filter((t) => t.direction === "declining");
  for (const t of declining) suggestions.push(`[${t.category}] Declining trend (delta ${t.delta}) - investigate recent changes.`);
  if (!suggestions.length) suggestions.push("All categories above baseline. Continue current approach.");

  return {
    generatedAt: new Date().toISOString(),
    totalEntries: allEntries.length,
    overallAvg: mean(allEntries.map((e) => e.score)),
    bestScore: { id: best.id, score: best.score, category: best.category },
    worstScore: { id: worst.id, score: worst.score, category: worst.category },
    byCategory,
    trends,
    suggestions,
  };
}

// CLI entry point
if (import.meta.main) {
  const report = await aggregateBenchmarks();
  console.log(JSON.stringify(report, null, 2));
}
