#!/usr/bin/env bun
/**
 * validate-checkpoint.ts — RL checkpoint validation gate
 *
 * Runs the autoresearch benchmark suite against a fine-tuned model checkpoint
 * and compares scores against the pre-training baseline. If the checkpoint
 * regresses on any category, it reports failure so the LoRA can be rolled back.
 *
 * Usage:
 *   bun run benchmarks/autoresearch/validate-checkpoint.ts [--model <model>] [--baseline <path>]
 *
 * Environment:
 *   METACLAW_PROXY_URL — MetaClaw proxy URL (default: http://localhost:30000)
 *   OPENROUTER_API_KEY — for judge model (gemini-2.5-flash:free)
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";

import type { BenchmarkDefinition } from "../types";

import { bugFixingBenchmarks } from "../categories/bug-fixing/benchmarks";
import { fileManipulationBenchmarks } from "../categories/file-manipulation/benchmarks";
import { featureImplementationBenchmarks } from "../categories/feature-implementation/benchmarks";
import { grade } from "./execution-grader";
import { getSystemPrompt } from "./system-prompt";

// ── Config ──────────────────────────────────────────────────────────

const ROOT = resolve(dirname(import.meta.dir));
const BASELINE_PATH = resolve(ROOT, "autoresearch/checkpoint-baseline.json");
const RESULTS_PATH = resolve(ROOT, "autoresearch/checkpoint-results.json");

const MODEL = process.argv.includes("--model")
  ? process.argv[process.argv.indexOf("--model") + 1]
  : "qwen2.5-coder:14b";

const PROXY_URL = process.env.METACLAW_PROXY_URL || "http://localhost:30000";
const PASS_THRESHOLD = 80;

// ── Benchmarks (subset for fast validation) ─────────────────────────

const VALIDATION_BENCHMARKS: BenchmarkDefinition[] = [
  ...bugFixingBenchmarks.slice(0, 2),
  ...fileManipulationBenchmarks.slice(0, 1),
  ...featureImplementationBenchmarks.slice(0, 1),
];

// ── Types ───────────────────────────────────────────────────────────

interface CheckpointScore {
  benchmarkId: string;
  score: number;
  timestamp: string;
}

interface ValidationResult {
  model: string;
  proxyUrl: string;
  timestamp: string;
  scores: CheckpointScore[];
  avgScore: number;
  baselineAvg: number;
  passed: boolean;
  regressions: string[];
}

// ── Helpers ─────────────────────────────────────────────────────────

function loadBaseline(): CheckpointScore[] {
  if (!existsSync(BASELINE_PATH)) return [];
  return JSON.parse(readFileSync(BASELINE_PATH, "utf-8"));
}

function saveBaseline(scores: CheckpointScore[]): void {
  writeFileSync(BASELINE_PATH, JSON.stringify(scores, null, 2));
}

async function callModel(prompt: string): Promise<string> {
  const systemPrompt = getSystemPrompt();
  const response = await fetch(`${PROXY_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
      stream: false,
    }),
  });
  if (!response.ok) {
    throw new Error(`Model call failed: ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  return data.message?.content ?? "";
}

// ── Main ────────────────────────────────────────────────────────────

async function validate(): Promise<ValidationResult> {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  RL Checkpoint Validation Gate           ║`);
  console.log(`║  Model: ${MODEL.padEnd(32)}║`);
  console.log(`║  Proxy: ${PROXY_URL.padEnd(32)}║`);
  console.log(`╚══════════════════════════════════════════╝\n`);

  const baseline = loadBaseline();
  const baselineMap = new Map(baseline.map((b) => [b.benchmarkId, b.score]));

  const scores: CheckpointScore[] = [];
  const regressions: string[] = [];

  for (const bench of VALIDATION_BENCHMARKS) {
    console.log(`  Running ${bench.id}: ${bench.title}...`);
    const output = await callModel(bench.prompt);
    const result = await grade(bench, output);
    const score = result.score;
    const baselineScore = baselineMap.get(bench.id) ?? 0;
    const delta = score - baselineScore;
    const status = delta >= 0 ? "OK" : "REGRESSION";

    if (delta < 0) regressions.push(bench.id);

    scores.push({
      benchmarkId: bench.id,
      score,
      timestamp: new Date().toISOString(),
    });

    console.log(
      `    Score: ${score} (baseline: ${baselineScore}, delta: ${delta >= 0 ? "+" : ""}${delta}) [${status}]`
    );
  }

  const avgScore = scores.reduce((s, x) => s + x.score, 0) / scores.length;
  const baselineAvg =
    baseline.length > 0
      ? baseline.reduce((s, x) => s + x.score, 0) / baseline.length
      : 0;

  const passed = regressions.length === 0 && avgScore >= PASS_THRESHOLD;

  const result: ValidationResult = {
    model: MODEL,
    proxyUrl: PROXY_URL,
    timestamp: new Date().toISOString(),
    scores,
    avgScore: Math.round(avgScore * 100) / 100,
    baselineAvg: Math.round(baselineAvg * 100) / 100,
    passed,
    regressions,
  };

  writeFileSync(RESULTS_PATH, JSON.stringify(result, null, 2));

  console.log(`\n${"─".repeat(44)}`);
  console.log(`  Avg Score:    ${result.avgScore}`);
  console.log(`  Baseline Avg: ${result.baselineAvg}`);
  console.log(`  Regressions:  ${regressions.length === 0 ? "none" : regressions.join(", ")}`);
  console.log(`  Result:       ${passed ? "PASSED — safe to promote checkpoint" : "FAILED — rollback recommended"}`);
  console.log(`${"─".repeat(44)}\n`);

  // If this is the first run (no baseline), save current scores as baseline
  if (baseline.length === 0) {
    console.log("  No baseline found — saving current scores as baseline.");
    saveBaseline(scores);
  }

  return result;
}

validate().catch((err) => {
  console.error(`Validation error: ${err}`);
  process.exit(1);
});
