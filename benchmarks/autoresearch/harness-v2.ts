#!/usr/bin/env bun
/**
 * harness-v2.ts — 8gent Benchmark v2
 *
 * OpenRouter-backed, execution-graded benchmark harness with:
 * - Model fallback chain (openrouter/free → qwen → deepseek)
 * - Temperature sweep (0.3, 0.5, 0.7) per benchmark — keeps best
 * - Few-shot injection per category
 * - SWE-Bench style execution grading (70%) + keyword fallback (30%)
 * - Prompt mutation: accumulates learnings across iterations
 */

import { writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";

import type {
  BenchmarkDefinition,
  BenchmarkRun,
  HarnessConfig,
  CombinedGradeResult,
  TokenUsage,
} from "../types";

import { bugFixingBenchmarks } from "../categories/bug-fixing/benchmarks";
import { fileManipulationBenchmarks } from "../categories/file-manipulation/benchmarks";
import { featureImplementationBenchmarks } from "../categories/feature-implementation/benchmarks";
import { fullstackBenchmarks } from "../categories/fullstack/benchmarks";
import { agenticBenchmarks } from "../categories/agentic/benchmarks";
import { uiDesignBenchmarks } from "../categories/ui-design/benchmarks";
import { battleTestBenchmarks } from "../categories/battle-test/benchmarks";
import { battleTestProBenchmarks } from "../categories/battle-test/benchmarks-pro";
import { getFewShot } from "./few-shot";
import { grade } from "./execution-grader";
import { getSystemPrompt, addMutation, getMutations } from "./system-prompt";

// ── Config ──────────────────────────────────────────────────────────

const ROOT = resolve(dirname(import.meta.dir));

const config: HarnessConfig = {
  apiKey: process.env.OPENROUTER_API_KEY ?? "",
  models: [
    // ONLY :free models — openrouter/auto routes to PAID models
    "google/gemini-2.5-flash-lite:free",
    "google/gemini-2.5-flash:free",
    "meta-llama/llama-4-maverick:free",
  ],
  temperatures: [0.3, 0.5, 0.7],
  categories: [],               // empty = all
  outputFile: join(ROOT, "results-v2.tsv"),
  logFile: join(ROOT, "autoresearch", "run-v2.log"),
  mutatePrompt: true,
  systemPromptPath: join(ROOT, "autoresearch", "system-prompt.ts"),
  concurrency: 1,               // serial for now (API rate limits on free tier)
};

// ── All Benchmarks ──────────────────────────────────────────────────

const ALL_BENCHMARKS: BenchmarkDefinition[] = [
  ...bugFixingBenchmarks,
  ...fileManipulationBenchmarks,
  ...featureImplementationBenchmarks,
  ...fullstackBenchmarks,
  ...agenticBenchmarks,
  ...uiDesignBenchmarks,
  ...battleTestBenchmarks,
  ...battleTestProBenchmarks,
];

// ── OpenRouter API ──────────────────────────────────────────────────

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ApiResult {
  content: string;
  model: string;
  durationMs: number;
  tokenUsage: TokenUsage;
}

async function callOpenRouter(
  model: string,
  messages: ChatMessage[],
  temperature: number
): Promise<ApiResult> {
  const start = performance.now();

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
      "HTTP-Referer": "https://8gent.app",
      "X-Title": "8gent-benchmark-v2",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenRouter ${response.status}: ${body}`);
  }

  const json = await response.json() as any;
  const content = json.choices?.[0]?.message?.content ?? "";
  const actualModel = json.model ?? model;
  const usage = json.usage ?? {};

  return {
    content,
    model: actualModel,
    durationMs: Math.round(performance.now() - start),
    tokenUsage: {
      promptTokens: usage.prompt_tokens ?? 0,
      completionTokens: usage.completion_tokens ?? 0,
      totalTokens: usage.total_tokens ?? 0,
    },
  };
}

/**
 * Try each model in the fallback chain until one succeeds.
 */
async function callWithFallback(
  messages: ChatMessage[],
  temperature: number
): Promise<ApiResult> {
  let lastError: Error | null = null;

  for (const model of config.models) {
    try {
      return await callOpenRouter(model, messages, temperature);
    } catch (err: any) {
      lastError = err;
      log(`  ⚠ Model ${model} failed: ${err.message}, trying next...`);
    }
  }

  throw new Error(
    `All models failed. Last error: ${lastError?.message ?? "unknown"}`
  );
}

// ── Logging ─────────────────────────────────────────────────────────

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    appendFileSync(config.logFile, line + "\n");
  } catch {}
}

// ── Prompt Assembly ─────────────────────────────────────────────────

function buildMessages(benchmark: BenchmarkDefinition): ChatMessage[] {
  const systemPrompt = getSystemPrompt();
  const fewShot = getFewShot(benchmark.category);

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
  ];

  // Inject few-shot example as an assistant turn
  if (fewShot) {
    messages.push({
      role: "user",
      content: "Here is an example of how to solve a similar task:",
    });
    messages.push({
      role: "assistant",
      content: fewShot,
    });
  }

  messages.push({
    role: "user",
    content: benchmark.prompt,
  });

  return messages;
}

// ── Single Benchmark Run ────────────────────────────────────────────

async function runBenchmark(
  benchmark: BenchmarkDefinition,
  temperature: number
): Promise<BenchmarkRun> {
  const messages = buildMessages(benchmark);
  const { content, model, durationMs: apiMs, tokenUsage } = await callWithFallback(
    messages,
    temperature
  );

  const { code, result } = await grade(content, benchmark);

  return {
    benchmarkId: benchmark.id,
    model,
    temperature,
    rawOutput: content,
    extractedCode: code,
    grade: result,
    timestamp: Date.now(),
    durationMs: apiMs,
    tokenUsage,
  };
}

// ── Temperature Sweep ───────────────────────────────────────────────

/**
 * Run benchmark at each temperature, return the best result.
 */
async function sweepTemperatures(
  benchmark: BenchmarkDefinition
): Promise<BenchmarkRun> {
  let best: BenchmarkRun | null = null;

  for (const temp of config.temperatures) {
    log(`  ├─ temp=${temp}...`);

    try {
      const run = await runBenchmark(benchmark, temp);
      const tk = run.tokenUsage;
      log(
        `  │  score=${run.grade.score} (exec=${run.grade.execution?.score ?? "n/a"}, kw=${run.grade.keyword.score}) model=${run.model} tokens=${tk?.totalTokens ?? "?"} (in=${tk?.promptTokens ?? "?"}/out=${tk?.completionTokens ?? "?"}) ${run.durationMs}ms`
      );

      if (!best || run.grade.score > best.grade.score) {
        best = run;
      }
    } catch (err: any) {
      log(`  │  ✗ temp=${temp} failed: ${err.message}`);
    }
  }

  if (!best) {
    throw new Error(`All temperature sweeps failed for ${benchmark.id}`);
  }

  return best;
}

// ── Prompt Mutation ─────────────────────────────────────────────────

/**
 * Analyze a failed or low-scoring benchmark result and derive a learning.
 */
function deriveMutation(
  benchmark: BenchmarkDefinition,
  run: BenchmarkRun
): string | null {
  if (run.grade.score >= 80) return null; // good enough

  const failedTests = run.grade.execution?.failedTests ?? 0;
  const missedKw = run.grade.keyword.missedKeywords;

  const parts: string[] = [];

  // Analyze execution failures
  if (run.grade.execution && failedTests > 0) {
    const stderr = run.grade.execution.stderr;

    if (stderr.includes("export") || stderr.includes("Module must export")) {
      parts.push(
        "Always include both named exports AND a default export for the main class/function."
      );
    }
    if (stderr.includes("timeout") || run.grade.execution.timedOut) {
      parts.push(
        "Avoid infinite loops. Use bounded retry counts and timeouts in concurrent code."
      );
    }
    if (stderr.includes("null") || stderr.includes("undefined")) {
      parts.push(
        "Guard all property access on potentially null/undefined values. Use optional chaining (?.) and nullish coalescing (??)."
      );
    }
    if (stderr.includes("lock") || stderr.includes("mutex")) {
      parts.push(
        "For mutex/lock patterns, always release in a finally block. Use promise-chain serialization for async locks."
      );
    }
  }

  // Analyze keyword misses
  if (missedKw.length > 0 && missedKw.length <= 3) {
    parts.push(
      `Include these patterns in ${benchmark.category} tasks: ${missedKw.join(", ")}.`
    );
  }

  // Code extraction failures
  if (!run.extractedCode) {
    parts.push(
      "Always wrap code in a ```typescript fenced block. Do not include prose outside the block."
    );
  }

  if (parts.length === 0) return null;

  return `[${benchmark.id}] ${parts.join(" ")}`;
}

// ── Results Output ──────────────────────────────────────────────────

function initResultsFile(): void {
  const header = [
    "benchmark_id",
    "category",
    "title",
    "difficulty",
    "model",
    "temperature",
    "score",
    "exec_score",
    "kw_score",
    "method",
    "passed_tests",
    "total_tests",
    "exec_duration_ms",
    "api_duration_ms",
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "timestamp",
  ].join("\t");

  writeFileSync(config.outputFile, header + "\n");
}

function appendResult(
  benchmark: BenchmarkDefinition,
  run: BenchmarkRun
): void {
  const row = [
    run.benchmarkId,
    benchmark.category,
    benchmark.title,
    benchmark.difficulty,
    run.model,
    run.temperature,
    run.grade.score,
    run.grade.execution?.score ?? "",
    run.grade.keyword.score,
    run.grade.method,
    run.grade.execution?.passedTests ?? "",
    run.grade.execution?.totalTests ?? "",
    run.grade.execution?.durationMs ?? "",
    run.durationMs,
    run.tokenUsage?.promptTokens ?? "",
    run.tokenUsage?.completionTokens ?? "",
    run.tokenUsage?.totalTokens ?? "",
    new Date(run.timestamp).toISOString(),
  ].join("\t");

  appendFileSync(config.outputFile, row + "\n");
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!config.apiKey) {
    console.error("❌ OPENROUTER_API_KEY env var required");
    console.error("   export OPENROUTER_API_KEY=sk-or-...");
    process.exit(1);
  }

  // Ensure work directory exists
  mkdirSync(join(ROOT, "autoresearch", "work"), { recursive: true });

  log("═══════════════════════════════════════════════════════════════");
  log("  8gent Benchmark v2 — OpenRouter + Execution Grading");
  log("═══════════════════════════════════════════════════════════════");
  log(`  Models: ${config.models.join(" → ")}`);
  log(`  Temperatures: ${config.temperatures.join(", ")}`);
  log(`  Prompt mutation: ${config.mutatePrompt ? "ON" : "OFF"}`);
  log(`  Benchmarks: ${ALL_BENCHMARKS.length}`);
  log("");

  initResultsFile();

  const results: BenchmarkRun[] = [];
  let totalScore = 0;

  for (const benchmark of ALL_BENCHMARKS) {
    log(`┌─ ${benchmark.id}: ${benchmark.title} [${benchmark.difficulty}]`);

    try {
      const best = await sweepTemperatures(benchmark);
      results.push(best);
      totalScore += best.grade.score;

      appendResult(benchmark, best);

      log(
        `└─ ✓ Best: score=${best.grade.score} temp=${best.temperature} model=${best.model}`
      );

      // Prompt mutation: derive learnings from low scores
      if (config.mutatePrompt) {
        const mutation = deriveMutation(benchmark, best);
        if (mutation) {
          addMutation(mutation);
          log(`   📝 Mutation added: ${mutation}`);
        }
      }
    } catch (err: any) {
      log(`└─ ✗ FAILED: ${err.message}`);
      results.push({
        benchmarkId: benchmark.id,
        model: "none",
        temperature: 0,
        rawOutput: "",
        extractedCode: null,
        grade: {
          score: 0,
          execution: null,
          keyword: { score: 0, matchedKeywords: [], missedKeywords: benchmark.keywords },
          method: "keyword-only",
        },
        timestamp: Date.now(),
        durationMs: 0,
      });
    }

    log("");
  }

  // ── Summary ─────────────────────────────────────────────────────

  const avgScore = results.length > 0
    ? Math.round(totalScore / results.length)
    : 0;

  const passing = results.filter((r) => r.grade.score >= 70).length;

  log("═══════════════════════════════════════════════════════════════");
  log("  RESULTS SUMMARY");
  log("═══════════════════════════════════════════════════════════════");
  log(`  Total benchmarks: ${results.length}`);
  log(`  Passing (≥70):    ${passing}/${results.length}`);
  log(`  Average score:    ${avgScore}`);
  log("");

  let totalTokens = 0;
  let totalTime = 0;
  for (const run of results) {
    const bm = ALL_BENCHMARKS.find((b) => b.id === run.benchmarkId)!;
    const status = run.grade.score >= 70 ? "✓" : "✗";
    const tk = run.tokenUsage;
    totalTokens += tk?.totalTokens ?? 0;
    totalTime += run.durationMs;
    log(
      `  ${status} ${run.benchmarkId} ${bm.title.padEnd(40)} score=${String(run.grade.score).padStart(3)} temp=${run.temperature} tokens=${tk?.totalTokens ?? "?"} ${run.durationMs}ms`
    );
  }

  log("");
  log(`  Total tokens used:    ${totalTokens}`);
  log(`  Total API time:       ${(totalTime / 1000).toFixed(1)}s`);
  log(`  Avg tokens/benchmark: ${results.length > 0 ? Math.round(totalTokens / results.length) : 0}`);
  log(`  Avg time/benchmark:   ${results.length > 0 ? (totalTime / results.length / 1000).toFixed(1) : 0}s`);
  log(`  Score/1k tokens:      ${totalTokens > 0 ? (avgScore / (totalTokens / 1000)).toFixed(2) : "n/a"}`);

  log("");
  log(`  Results TSV: ${config.outputFile}`);
  log(`  Log file:    ${config.logFile}`);

  if (config.mutatePrompt) {
    const muts = getMutations();
    if (muts.length > 0) {
      log("");
      log(`  📝 Prompt mutations accumulated (${muts.length}):`);
      for (const m of muts) {
        log(`     • ${m}`);
      }

      // Write mutations to a separate file for persistence across runs
      const mutFile = join(ROOT, "autoresearch", "mutations.json");
      writeFileSync(
        mutFile,
        JSON.stringify(
          {
            timestamp: new Date().toISOString(),
            avgScore,
            passing: `${passing}/${results.length}`,
            mutations: muts,
          },
          null,
          2
        )
      );
      log(`  📝 Mutations saved to: ${mutFile}`);
    }
  }

  log("");
  log("═══════════════════════════════════════════════════════════════");
}

// ── Entry Point ─────────────────────────────────────────────────────

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
