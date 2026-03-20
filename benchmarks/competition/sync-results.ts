#!/usr/bin/env bun
/**
 * sync-results.ts — Sync overnight competition results to 8gent-world
 *
 * Reads competition + autoresearch state, generates summary,
 * updates 8gent-world benchmark pages, and optionally creates a GitHub gist.
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

// ── Paths ──────────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const COMPETITION_STATE = path.join(REPO_ROOT, "benchmarks/competition/competition-state.json");
const AUTORESEARCH_STATE = path.join(REPO_ROOT, "benchmarks/autoresearch/loop-state.json");
const EIGHT_WORLD = path.join(process.env.HOME ?? "~", "8gent-world");
const BENCHMARKING_PAGE = path.join(EIGHT_WORLD, "src/app/code/benchmarking/page.tsx");
const BENCHMARK_SCENE = path.join(EIGHT_WORLD, "remotion/scenes/BenchmarkShowcaseScene.tsx");

// ── Types ──────────────────────────────────────────────────────────────

interface CompetitionState {
  phase: string;
  startedAt: string;
  model: string;
  results: Record<string, {
    taskId: string;
    category: string;
    eightScore: number;
    claudeScore: number;
    winner: "8gent" | "claude" | "tie";
    durationMs?: number;
  }>;
  summary?: unknown;
}

interface LoopState {
  iteration: number;
  mutations: string[];
  history: {
    iteration: number;
    avgScore: number;
    passing: number;
    total: number;
    scores: Record<string, number>;
    tokens?: Record<string, number>;
    durations?: Record<string, number>;
    totalTokens?: number;
    totalDurationMs?: number;
    mutationsAdded?: string[];
    timestamp: string;
  }[];
  startedAt: string | null;
  lastRunAt: string | null;
}

interface TierScore {
  tier: string;
  label: string;
  score: number;
  prevScore?: number;
  taskCount: number;
  passing: number;
}

interface SyncSummary {
  date: string;
  model: string;
  tierScores: TierScore[];
  headToHead: {
    eightWins: number;
    claudeWins: number;
    ties: number;
    total: number;
    winRate: number;
  };
  improvements: {
    tier: string;
    before: number;
    after: number;
    delta: number;
  }[];
  autoresearch: {
    iterations: number;
    mutations: number;
    latestAvg: number;
    latestPassing: string;
  };
}

// ── Tier mapping (BT = Tier 5, BF/FM = Tier 1, FS = Tier 2, etc.) ────

function getTierFromId(id: string): string {
  if (id.startsWith("BF") || id.startsWith("FM")) return "Tier 1";
  if (id.startsWith("FS")) return "Tier 2";
  if (id.startsWith("TC") || id.startsWith("DP") || id.startsWith("RE") || id.startsWith("SD") || id.startsWith("AR") || id.startsWith("CB") || id.startsWith("MR")) return "Tier 3";
  if (id.startsWith("UI")) return "Tier 4";
  if (id.startsWith("BT")) return "Tier 5";
  return "Unknown";
}

const TIER_LABELS: Record<string, string> = {
  "Tier 1": "Fundamentals",
  "Tier 2": "Fullstack",
  "Tier 3": "Agentic",
  "Tier 4": "UI/CSS",
  "Tier 5": "Battle Test",
};

// ── Read state files ──────────────────────────────────────────────────

function readJson<T>(filePath: string): T | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    console.error(`Could not read ${filePath}`);
    return null;
  }
}

// ── Build summary ─────────────────────────────────────────────────────

function buildSummary(): SyncSummary {
  const competition = readJson<CompetitionState>(COMPETITION_STATE);
  const autoresearch = readJson<LoopState>(AUTORESEARCH_STATE);
  const date = new Date().toISOString().split("T")[0];

  // Head-to-head results
  const results = competition?.results ? Object.values(competition.results) : [];
  const eightWins = results.filter(r => r.winner === "8gent").length;
  const claudeWins = results.filter(r => r.winner === "claude").length;
  const ties = results.filter(r => r.winner === "tie").length;
  const total = results.length;

  // Per-tier scores from competition results
  const tierMap = new Map<string, { scores: number[]; ids: string[] }>();
  for (const r of results) {
    const tier = getTierFromId(r.taskId);
    if (!tierMap.has(tier)) tierMap.set(tier, { scores: [], ids: [] });
    tierMap.get(tier)!.scores.push(r.eightScore);
    tierMap.get(tier)!.ids.push(r.taskId);
  }

  // If competition didn't run or had no results, fall back to autoresearch battle-test data
  if (tierMap.size === 0 && autoresearch?.history?.length) {
    const latest = autoresearch.history[autoresearch.history.length - 1];
    const scores = latest.scores ?? {};
    for (const [id, score] of Object.entries(scores)) {
      const tier = getTierFromId(id);
      if (!tierMap.has(tier)) tierMap.set(tier, { scores: [], ids: [] });
      tierMap.get(tier)!.scores.push(score);
      tierMap.get(tier)!.ids.push(id);
    }
  }

  // Build tier scores
  const tierScores: TierScore[] = ["Tier 1", "Tier 2", "Tier 3", "Tier 4", "Tier 5"].map(tier => {
    const data = tierMap.get(tier);
    if (!data || data.scores.length === 0) {
      return { tier, label: TIER_LABELS[tier], score: 0, taskCount: 0, passing: 0 };
    }
    const avg = Math.round(data.scores.reduce((a, b) => a + b, 0) / data.scores.length);
    const passing = data.scores.filter(s => s >= 70).length;
    return { tier, label: TIER_LABELS[tier], score: avg, taskCount: data.scores.length, passing };
  });

  // Calculate improvements from autoresearch history
  const improvements: SyncSummary["improvements"] = [];
  if (autoresearch?.history && autoresearch.history.length >= 2) {
    const first = autoresearch.history[0];
    const latest = autoresearch.history[autoresearch.history.length - 1];
    // Group by tier in first and latest
    for (const tier of ["Tier 1", "Tier 2", "Tier 3", "Tier 4", "Tier 5"]) {
      const firstScores: number[] = [];
      const latestScores: number[] = [];
      for (const [id, score] of Object.entries(first.scores ?? {})) {
        if (getTierFromId(id) === tier) firstScores.push(score);
      }
      for (const [id, score] of Object.entries(latest.scores ?? {})) {
        if (getTierFromId(id) === tier) latestScores.push(score);
      }
      if (firstScores.length > 0 && latestScores.length > 0) {
        const before = Math.round(firstScores.reduce((a, b) => a + b, 0) / firstScores.length);
        const after = Math.round(latestScores.reduce((a, b) => a + b, 0) / latestScores.length);
        improvements.push({ tier, before, after, delta: after - before });
      }
    }
  }

  // Autoresearch summary
  const latestHistory = autoresearch?.history?.[autoresearch.history.length - 1];
  const autoresearchSummary = {
    iterations: autoresearch?.iteration ?? 0,
    mutations: autoresearch?.mutations?.length ?? 0,
    latestAvg: latestHistory?.avgScore ?? 0,
    latestPassing: latestHistory ? `${latestHistory.passing}/${latestHistory.total}` : "0/0",
  };

  return {
    date,
    model: competition?.model ?? process.env.EIGHT_MODEL ?? "eight:latest",
    tierScores,
    headToHead: {
      eightWins,
      claudeWins,
      ties,
      total,
      winRate: total > 0 ? Math.round((eightWins / total) * 100) : 0,
    },
    improvements,
    autoresearch: autoresearchSummary,
  };
}

// ── Update 8gent-world benchmarking page ──────────────────────────────

function updateBenchmarkingPage(summary: SyncSummary): boolean {
  if (!fs.existsSync(BENCHMARKING_PAGE)) {
    console.log("8gent-world benchmarking page not found — skipping");
    return false;
  }

  let content = fs.readFileSync(BENCHMARKING_PAGE, "utf-8");

  // Update SCORE_HISTORY array — append new iteration data for Tier 5 (battle-test)
  const tier5 = summary.tierScores.find(t => t.tier === "Tier 5");
  if (tier5 && tier5.score > 0) {
    // Find the Tier 5 entry in SCORE_HISTORY and append a new iteration
    const tier5Pattern = /(\{ category: "Tier 5 \(Battle Test — 15 domains\)", iterations: \[[\s\S]*?)(]\})/;
    const match = content.match(tier5Pattern);
    if (match) {
      // Find the last iteration number
      const iterPattern = /iter: (\d+)/g;
      let lastIter = 0;
      let iterMatch;
      while ((iterMatch = iterPattern.exec(match[1])) !== null) {
        lastIter = Math.max(lastIter, parseInt(iterMatch[1]));
      }
      const newIter = lastIter + 1;
      const newEntry = `\n    { iter: ${newIter}, avg: ${tier5.score}, passing: "${tier5.passing}/${tier5.taskCount}" },\n  `;
      content = content.replace(tier5Pattern, `$1${newEntry}$2`);
    }
  }

  // Update other tier scores similarly
  for (const tier of summary.tierScores) {
    if (tier.tier === "Tier 5" || tier.score === 0) continue;

    const tierNum = tier.tier.replace("Tier ", "");
    // Match the tier pattern dynamically
    const escapedLabel = tier.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(
      `(\\{ category: "Tier ${tierNum} \\(${escapedLabel}[^"]*\\)", iterations: \\[[\\s\\S]*?)(]\\})`,
    );
    const match = content.match(pattern);
    if (match) {
      const iterPattern = /iter: (\d+)/g;
      let lastIter = 0;
      let iterMatch;
      while ((iterMatch = iterPattern.exec(match[1])) !== null) {
        lastIter = Math.max(lastIter, parseInt(iterMatch[1]));
      }
      const newIter = lastIter + 1;
      const newEntry = `\n    { iter: ${newIter}, avg: ${tier.score}, passing: "${tier.passing}/${tier.taskCount}" },\n  `;
      content = content.replace(pattern, `$1${newEntry}$2`);
    }
  }

  fs.writeFileSync(BENCHMARKING_PAGE, content);
  console.log(`Updated: ${BENCHMARKING_PAGE}`);
  return true;
}

// ── Update BenchmarkShowcaseScene tier scores ─────────────────────────

function updateBenchmarkScene(summary: SyncSummary): boolean {
  if (!fs.existsSync(BENCHMARK_SCENE)) {
    console.log("BenchmarkShowcaseScene not found — skipping");
    return false;
  }

  let content = fs.readFileSync(BENCHMARK_SCENE, "utf-8");

  for (const tier of summary.tierScores) {
    if (tier.score === 0) continue;

    // Match: { name: "Tier X", label: "...", color: "...", score: NN },
    const pattern = new RegExp(
      `(\\{ name: "${tier.tier}", label: "${tier.label}", color: "[^"]+", score: )\\d+(\\s*\\})`,
    );
    content = content.replace(pattern, `$1${tier.score}$2`);
  }

  fs.writeFileSync(BENCHMARK_SCENE, content);
  console.log(`Updated: ${BENCHMARK_SCENE}`);
  return true;
}

// ── Git commit in 8gent-world ─────────────────────────────────────────

function commitToWorld(summary: SyncSummary): boolean {
  if (!fs.existsSync(EIGHT_WORLD)) return false;

  try {
    const dateStr = summary.date;
    const tier5 = summary.tierScores.find(t => t.tier === "Tier 5");
    const msg = `chore(benchmarks): update scores from overnight competition ${dateStr}\n\nTier 5 avg: ${tier5?.score ?? "N/A"}% | H2H: ${summary.headToHead.eightWins}W-${summary.headToHead.claudeWins}L-${summary.headToHead.ties}T`;

    execSync("git add -A", { cwd: EIGHT_WORLD, stdio: "pipe" });

    // Check if there are changes to commit
    const status = execSync("git status --porcelain", { cwd: EIGHT_WORLD, encoding: "utf-8" });
    if (!status.trim()) {
      console.log("No changes to commit in 8gent-world");
      return false;
    }

    execSync(`git commit -m "${msg}"`, { cwd: EIGHT_WORLD, stdio: "pipe" });
    console.log(`Committed to 8gent-world: ${msg.split("\n")[0]}`);
    return true;
  } catch (err) {
    console.error("Failed to commit to 8gent-world:", err);
    return false;
  }
}

// ── GitHub Gist ───────────────────────────────────────────────────────

function createGist(summary: SyncSummary): string | null {
  try {
    execSync("which gh", { stdio: "pipe" });
  } catch {
    console.log("gh CLI not available — skipping gist creation");
    return null;
  }

  try {
    const gistContent = JSON.stringify(summary, null, 2);
    const tmpFile = path.join(REPO_ROOT, `.8gent/competition-summary-${summary.date}.json`);
    fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
    fs.writeFileSync(tmpFile, gistContent);

    const result = execSync(
      `gh gist create "${tmpFile}" --desc "8gent overnight competition results ${summary.date}" --public`,
      { encoding: "utf-8", cwd: REPO_ROOT },
    ).trim();

    console.log(`Gist created: ${result}`);
    return result;
  } catch (err) {
    console.error("Failed to create gist:", err);
    return null;
  }
}

// ── Format summary for stdout ─────────────────────────────────────────

function formatSummary(summary: SyncSummary): string {
  const lines: string[] = [];

  lines.push("═══════════════════════════════════════════════════════════");
  lines.push(`  8gent Overnight Competition Summary — ${summary.date}`);
  lines.push(`  Model: ${summary.model}`);
  lines.push("═══════════════════════════════════════════════════════════");
  lines.push("");

  // Tier scores
  lines.push("  Tier Scores:");
  for (const t of summary.tierScores) {
    const bar = "█".repeat(Math.floor(t.score / 5)) + "░".repeat(20 - Math.floor(t.score / 5));
    lines.push(`    ${t.tier} (${t.label.padEnd(12)}) ${bar} ${t.score}% (${t.passing}/${t.taskCount} passing)`);
  }
  lines.push("");

  // Head-to-head
  const h2h = summary.headToHead;
  lines.push("  Head-to-Head vs Claude:");
  lines.push(`    8gent wins:  ${h2h.eightWins}`);
  lines.push(`    Claude wins: ${h2h.claudeWins}`);
  lines.push(`    Ties:        ${h2h.ties}`);
  lines.push(`    Win rate:    ${h2h.winRate}%`);
  lines.push("");

  // Improvements
  if (summary.improvements.length > 0) {
    lines.push("  Score Improvements (first → latest iteration):");
    for (const imp of summary.improvements) {
      const arrow = imp.delta >= 0 ? "↑" : "↓";
      lines.push(`    ${imp.tier}: ${imp.before}% → ${imp.after}% (${arrow}${Math.abs(imp.delta)})`);
    }
    lines.push("");
  }

  // Autoresearch
  const ar = summary.autoresearch;
  lines.push("  Autoresearch:");
  lines.push(`    Iterations: ${ar.iterations}`);
  lines.push(`    Mutations:  ${ar.mutations}`);
  lines.push(`    Latest avg: ${ar.latestAvg}%`);
  lines.push(`    Passing:    ${ar.latestPassing}`);
  lines.push("");

  lines.push("═══════════════════════════════════════════════════════════");

  return lines.join("\n");
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  console.log("Building competition summary...\n");

  const summary = buildSummary();

  // Print formatted summary to stdout
  const formatted = formatSummary(summary);
  console.log(formatted);

  // Save raw summary JSON
  const summaryPath = path.join(REPO_ROOT, `.8gent/competition-summary-${summary.date}.json`);
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`\nSaved summary: ${summaryPath}`);

  // Update 8gent-world if it exists
  if (fs.existsSync(EIGHT_WORLD)) {
    console.log("\nSyncing to 8gent-world...");
    const pageUpdated = updateBenchmarkingPage(summary);
    const sceneUpdated = updateBenchmarkScene(summary);

    if (pageUpdated || sceneUpdated) {
      const committed = commitToWorld(summary);
      if (committed) {
        console.log("Changes committed to 8gent-world");
      }
    }
  } else {
    console.log("\n~/8gent-world not found — skipping sync");
  }

  // Create GitHub gist
  const gistUrl = createGist(summary);
  if (gistUrl) {
    console.log(`\nGist: ${gistUrl}`);
  }

  // Output summary JSON to stdout for orchestrator to parse
  console.log("\n--- SUMMARY_JSON_START ---");
  console.log(JSON.stringify(summary));
  console.log("--- SUMMARY_JSON_END ---");
}

main().catch((err) => {
  console.error("sync-results failed:", err);
  process.exit(1);
});
