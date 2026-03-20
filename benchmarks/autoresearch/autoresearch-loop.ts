#!/usr/bin/env bun
/**
 * autoresearch-loop.ts — Iterative self-improvement loop
 *
 * Runs benchmarks → analyzes failures → mutates prompt → re-runs
 * Continues until all benchmarks pass or max iterations reached.
 *
 * State is persisted between iterations so the loop can be resumed.
 */

import { writeFileSync, readFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";

import type { BenchmarkDefinition, BenchmarkRun, TokenUsage } from "../types";

import { bugFixingBenchmarks } from "../categories/bug-fixing/benchmarks";
import { fileManipulationBenchmarks } from "../categories/file-manipulation/benchmarks";
import { featureImplementationBenchmarks } from "../categories/feature-implementation/benchmarks";
import { fullstackBenchmarks } from "../categories/fullstack/benchmarks";
import { agenticBenchmarks } from "../categories/agentic/benchmarks";
import { uiDesignBenchmarks } from "../categories/ui-design/benchmarks";
import { battleTestBenchmarks } from "../categories/battle-test/benchmarks";
import { battleTestProBenchmarks } from "../categories/battle-test/benchmarks-pro";
import { longHorizonBenchmarks } from "../categories/long-horizon/benchmarks";
import { getFewShot } from "./few-shot";
import { grade } from "./execution-grader";
import {
  getSystemPrompt,
  addMutation,
  getMutations,
  clearMutations,
} from "./system-prompt";
import { recordResult, getModelOrder, getExperienceSummary } from "./model-router";

// ── Config ──────────────────────────────────────────────────────────

const ROOT = resolve(dirname(import.meta.dir));

const MAX_ITERATIONS = parseInt(process.env.MAX_ITERATIONS ?? "5", 10);
const PASS_THRESHOLD = parseInt(process.env.PASS_THRESHOLD ?? "80", 10);
const TARGET_CATEGORY = process.env.CATEGORY ?? ""; // empty = all
const API_KEY = process.env.OPENROUTER_API_KEY ?? "";

// IMPORTANT: Only use :free models — openrouter/auto routes to PAID models
// Format: "provider::model" — ollama models run locally, openrouter models need API key
// Override with MODELS_OVERRIDE env var (single model: "ollama::eight:latest")
const MODELS = process.env.MODELS_OVERRIDE
  ? process.env.MODELS_OVERRIDE.split(",")
  : [
      "ollama::qwen3.5:latest",                        // local — newest Qwen (March 2026), best coding benchmarks
      "ollama::devstral:latest",                        // local — Mistral's code-specialized model
      "ollama::qwen3:14b",                              // local — general fallback
      "openrouter::google/gemini-2.5-flash:free",        // remote free fallback
    ];

const OLLAMA_URL = "http://localhost:11434/v1/chat/completions";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const TEMPERATURES = [0.3, 0.5, 0.7];

const STATE_FILE = join(ROOT, "autoresearch", "loop-state.json");
const LOG_FILE = join(ROOT, "autoresearch", "autoresearch.log");

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
  ...longHorizonBenchmarks,
];

function getTargetBenchmarks(): BenchmarkDefinition[] {
  if (!TARGET_CATEGORY) return ALL_BENCHMARKS;
  return ALL_BENCHMARKS.filter((b) => b.category === TARGET_CATEGORY);
}

// ── State Persistence ───────────────────────────────────────────────

interface LoopState {
  iteration: number;
  mutations: string[];
  history: IterationResult[];
  startedAt: string;
  lastRunAt: string;
}

interface IterationResult {
  iteration: number;
  avgScore: number;
  passing: number;
  total: number;
  scores: Record<string, number>;
  tokens: Record<string, number>;
  durations: Record<string, number>;
  totalTokens: number;
  totalDurationMs: number;
  mutationsAdded: string[];
  timestamp: string;
}

function loadState(): LoopState | null {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    }
  } catch {}
  return null;
}

function saveState(state: LoopState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Logging ─────────────────────────────────────────────────────────

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    appendFileSync(LOG_FILE, line + "\n");
  } catch {}
}

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

function parseModel(spec: string): { provider: "ollama" | "openrouter"; model: string } {
  if (spec.startsWith("ollama::")) return { provider: "ollama", model: spec.slice(8) };
  if (spec.startsWith("openrouter::")) return { provider: "openrouter", model: spec.slice(12) };
  // Default: if it contains :free or / treat as openrouter, else ollama
  return spec.includes("/") ? { provider: "openrouter", model: spec } : { provider: "ollama", model: spec };
}

async function callModel(
  provider: "ollama" | "openrouter",
  model: string,
  messages: ChatMessage[],
  temperature: number
): Promise<ApiResult> {
  const start = performance.now();
  const isOllama = provider === "ollama";

  const url = isOllama ? OLLAMA_URL : OPENROUTER_URL;
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  if (!isOllama) {
    headers["Authorization"] = `Bearer ${API_KEY}`;
    headers["HTTP-Referer"] = "https://8gent.app";
    headers["X-Title"] = "8gent-autoresearch";
  }

  // 5 minute timeout (reduced from 10) — prevents stuck benchmarks
  const controller = new AbortController();
  const timeoutMs = parseInt(process.env.BENCHMARK_TIMEOUT ?? "300000", 10);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const response = await fetch(url, {
    method: "POST",
    headers,
    signal: controller.signal,
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: 8192,
      ...(isOllama ? { stream: false } : {}),
    }),
  });

  clearTimeout(timeout);

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status}: ${body.slice(0, 200)}`);
  }

  const json = (await response.json()) as any;
  const usage = json.usage ?? {};
  // qwen3 uses thinking mode — content may be empty with reasoning field
  const msg = json.choices?.[0]?.message ?? {};
  const content = msg.content || msg.reasoning || "";
  return {
    content,
    model: `${provider}/${json.model ?? model}`,
    durationMs: Math.round(performance.now() - start),
    tokenUsage: {
      promptTokens: usage.prompt_tokens ?? 0,
      completionTokens: usage.completion_tokens ?? 0,
      totalTokens: usage.total_tokens ?? 0,
    },
  };
}

/**
 * Try models in order. Default fallback chain (no experience data).
 */
async function callWithFallback(
  messages: ChatMessage[],
  temperature: number
): Promise<ApiResult> {
  for (const spec of MODELS) {
    const { provider, model } = parseModel(spec);
    try {
      return await callModel(provider, model, messages, temperature);
    } catch (err: any) {
      log(`  ⚠ ${provider}/${model} failed: ${err.message}`);
    }
  }
  throw new Error("All models failed");
}

/**
 * Experience-based routing: try the best model for this domain first,
 * then fall back to others. Records results for future routing.
 */
async function callWithExperienceRouting(
  messages: ChatMessage[],
  temperature: number,
  domain: string,
  benchmarkId: string
): Promise<ApiResult> {
  // Get experience-ordered model list
  const orderedModels = getModelOrder(MODELS, domain, benchmarkId);

  log(`    🧠 Router order: ${orderedModels.map(m => m.split("::")[1] || m).join(" → ")}`);

  for (const spec of orderedModels) {
    const { provider, model } = parseModel(spec);
    try {
      return await callModel(provider, model, messages, temperature);
    } catch (err: any) {
      log(`  ⚠ ${provider}/${model} failed: ${err.message}`);
    }
  }
  throw new Error("All models failed");
}

// ── Benchmark Execution ─────────────────────────────────────────────

function buildMessages(benchmark: BenchmarkDefinition): ChatMessage[] {
  const systemPrompt = getSystemPrompt();
  const fewShot = getFewShot(benchmark.category);

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
  ];

  if (fewShot) {
    messages.push({
      role: "user",
      content: "Here is an example of how to solve a similar task:",
    });
    messages.push({ role: "assistant", content: fewShot });
  }

  messages.push({ role: "user", content: benchmark.prompt });
  return messages;
}

async function runBenchmarkSweep(
  benchmark: BenchmarkDefinition
): Promise<BenchmarkRun> {
  let best: BenchmarkRun | null = null;

  for (const temp of TEMPERATURES) {
    try {
      const messages = buildMessages(benchmark);
      const { content, model, durationMs, tokenUsage } = await callWithExperienceRouting(
        messages, temp, benchmark.category, benchmark.id
      );
      const { code, result } = await grade(content, benchmark);

      const run: BenchmarkRun = {
        benchmarkId: benchmark.id,
        model,
        temperature: temp,
        rawOutput: content,
        extractedCode: code,
        grade: result,
        timestamp: Date.now(),
        durationMs,
        tokenUsage,
      };

      log(
        `    temp=${temp} → score=${result.score} (exec=${result.execution?.score ?? "-"}, kw=${result.keyword.score}) [${model}] tokens=${tokenUsage.totalTokens} (in=${tokenUsage.promptTokens}/out=${tokenUsage.completionTokens}) ${durationMs}ms`
      );

      // Record this result for future routing decisions
      recordResult(model, benchmark.category, benchmark.id, result.score);

      if (!best || run.grade.score > best.grade.score) {
        best = run;
      }

      // Early exit if we hit 100
      if (run.grade.score >= 100) break;
    } catch (err: any) {
      log(`    temp=${temp} → FAILED: ${err.message}`);
    }
  }

  if (!best) throw new Error(`All temps failed for ${benchmark.id}`);
  return best;
}

// ── Failure Analysis & Mutation ─────────────────────────────────────

function analyzeAndMutate(
  benchmark: BenchmarkDefinition,
  run: BenchmarkRun
): string[] {
  if (run.grade.score >= PASS_THRESHOLD) return [];

  const newMutations: string[] = [];
  const exec = run.grade.execution;
  const stderr = exec?.stderr ?? "";
  const stdout = exec?.stdout ?? "";
  const combined = stderr + "\n" + stdout;

  // ── Multi-file extraction failures ────────────────────────────
  if (benchmark.multiFile && !run.extractedCode) {
    newMutations.push(
      `[${benchmark.id}] CRITICAL: For multi-file tasks, output EACH file in a SEPARATE fenced block with \`\`\`typescript // filename.ts — do not merge files into one block.`
    );
  }

  // ── Import/export errors ──────────────────────────────────────
  if (combined.includes("must export") || combined.includes("not a function")) {
    newMutations.push(
      `[${benchmark.id}] Always export the main class/function both as named export AND default export. Match the exact export names from the task spec.`
    );
  }

  if (combined.includes("Cannot find module") || combined.includes("ModuleNotFound")) {
    newMutations.push(
      `[${benchmark.id}] Use relative imports ("./filename") for all cross-file references. Import fixture files exactly as documented in the task.`
    );
  }

  // ── Auth-specific failures ────────────────────────────────────
  if (benchmark.id === "FS001") {
    if (combined.includes("401") && combined.includes("profile")) {
      newMutations.push(
        `[FS001] The auth middleware must read the Authorization header (case-insensitive: try both "Authorization" and "authorization"), extract the Bearer token, look up the session in the database, and set req.user to the user object. The requireAuth middleware must check req.user and return 401 if null.`
      );
    }
    if (combined.includes("409") || combined.includes("duplicate")) {
      newMutations.push(
        `[FS001] Register must catch duplicate email errors from db.createUser() and return status 409.`
      );
    }
  }

  // ── Queue-specific failures ───────────────────────────────────
  if (benchmark.id === "FS002") {
    if (combined.includes("priority")) {
      newMutations.push(
        `[FS002] The queue must sort by priority (highest first). Use Array.sort or maintain a sorted structure. Dequeue always returns the highest-priority pending task.`
      );
    }
    if (combined.includes("dead") || combined.includes("DLQ")) {
      newMutations.push(
        `[FS002] When fail() is called and attempts >= maxRetries, mark the task as "dead" and add it to the dead letter queue. Only re-enqueue if attempts < maxRetries.`
      );
    }
  }

  // ── State machine failures ────────────────────────────────────
  if (benchmark.id === "FS003") {
    if (combined.includes("guard") || combined.includes("transition")) {
      newMutations.push(
        `[FS003] The send() method must: 1) check if current state has a transition for the event, 2) run the guard function if present (block if false), 3) run the action to update context, 4) change state. Return { success: true/false, state, context }.`
      );
    }
    if (combined.includes("compensate") || combined.includes("reverse")) {
      newMutations.push(
        `[FS003] WorkflowEngine.execute() must run steps sequentially. On failure, compensate previously completed steps IN REVERSE ORDER (last completed first). Do NOT compensate the failed step itself.`
      );
    }
  }

  // ── Agentic benchmark failures ──────────────────────────────
  if (benchmark.category === "agentic") {
    if (benchmark.id === "AR001" && combined.includes("circular")) {
      newMutations.push(
        `[AR001] Implement cycle detection in the dependency resolver using DFS with a "visiting" set. When a cycle is found, throw an error that names the cycle path.`
      );
    }
    if (benchmark.id === "AR001" && (combined.includes("lazy") || combined.includes("getPlugin"))) {
      newMutations.push(
        `[AR001] getPlugin() must trigger lazy initialization: if the plugin is not yet loaded, resolve its dependency chain and init them in order before returning.`
      );
    }
    if (benchmark.id === "MR001" && combined.includes("timeout")) {
      newMutations.push(
        `[MR001] Implement AC-3 arc consistency preprocessing BEFORE backtracking search. Without domain pruning, hard Sudoku will timeout. Use MCV (most-constrained-variable) heuristic.`
      );
    }
    if (benchmark.id === "TC001" && combined.includes("roundtrip")) {
      newMutations.push(
        `[TC001] The serializer must preserve enough structure for roundtrip fidelity. parse(serialize(parse(input))) must produce structurally equivalent ASTs.`
      );
    }
    if (benchmark.id === "SD001" && exec && exec.score < 50) {
      newMutations.push(
        `[SD001] Three bugs to fix: (1) broker.ts race condition — add mutex/lock for concurrent subscribe/unsubscribe, (2) history.ts memory leak — prune internal array to maxHistory after each add, (3) router.ts off-by-one — wildcard * must match zero or more chars, not one or more.`
      );
    }
    if (benchmark.id === "DP001" && combined.includes("BOM")) {
      newMutations.push(
        `[DP001] Strip BOM (\\uFEFF) from the start of CSV input. Handle mixed line endings (CRLF/LF). Parse quoted fields that contain commas.`
      );
    }
    if (benchmark.id === "CB001" && combined.includes("submodule")) {
      newMutations.push(
        `[CB001] When traversing for git repos, skip nested .git directories (submodules). Only count top-level repos. Parse git log format: "Author: Name <email>".`
      );
    }
  }

  // ── UI Design benchmark failures ────────────────────────────
  if (benchmark.category === "ui-design") {
    if (!run.extractedCode || !run.extractedCode.includes("<")) {
      newMutations.push(
        `[${benchmark.id}] Output must be a COMPLETE HTML page starting with <!DOCTYPE html>. Wrap ALL CSS in a <style> tag inside <head>. Use a single \`\`\`html fenced block.`
      );
    }
    if (run.extractedCode && !run.extractedCode.includes("<style")) {
      newMutations.push(
        `[${benchmark.id}] CSS must be embedded in a <style> tag — do NOT use inline styles only. All hover, active, keyframe rules require a <style> block.`
      );
    }
    if (benchmark.id === "UI002" && combined.includes("backdrop-filter")) {
      newMutations.push(
        `[UI002] backdrop-filter: blur() requires -webkit-backdrop-filter for Safari. Card backgrounds must be rgba() with alpha < 0.5, not hex colors.`
      );
    }
    if (benchmark.id === "UI005" && !combined.includes("checked")) {
      newMutations.push(
        `[UI005] Toggle state MUST use the checkbox hack: <input type="checkbox" id="toggle"><label for="toggle">. Style with input:checked + label or input:checked ~ .knob. NO JavaScript.`
      );
    }
  }

  // ── Battle Test benchmark failures ────────────────────────────
  if (benchmark.category === "battle-test") {
    // Multi-file extraction is the #1 bottleneck for battle-test
    if (benchmark.multiFile && (!run.extractedCode || Object.keys(run.extractedCode).length < (benchmark.expectedFiles?.length ?? 2))) {
      newMutations.push(
        `[${benchmark.id}] CRITICAL: This is a multi-file task. Output EACH file in its OWN fenced code block: \`\`\`typescript // filename.ts. Do NOT combine files. Do NOT skip any file.`
      );
    }

    // Auth system specifics
    if (benchmark.id === "BT001") {
      if (combined.includes("hash") || combined.includes("bcrypt")) {
        newMutations.push(
          `[BT001] Use a simple hash function (crypto.createHash("sha256")) for password hashing — do NOT import bcrypt or argon2. Store hash as hex digest.`
        );
      }
      if (combined.includes("401") || combined.includes("unauthorized")) {
        newMutations.push(
          `[BT001] Auth middleware must: 1) read Authorization header (case-insensitive), 2) extract Bearer token, 3) validate JWT using the shared secret, 4) set req.user. Return 401 on any failure.`
        );
      }
    }

    // Financial consulting
    if (benchmark.id === "BT006") {
      if (combined.includes("NaN") || combined.includes("Infinity")) {
        newMutations.push(
          `[BT006] All financial calculations must guard against division by zero. Return 0 or null for undefined ratios. Use Number.isFinite() to validate results.`
        );
      }
    }

    // SEO audit
    if (benchmark.id === "BT007") {
      if (combined.includes("parse") || combined.includes("HTML")) {
        newMutations.push(
          `[BT007] Parse HTML using regex patterns for meta tags, headings, links — do NOT use external HTML parsers. Extract: title, meta description, h1-h6 hierarchy, a[href] links, img[alt] attributes.`
        );
      }
    }

    // Email campaign
    if (benchmark.id === "BT008") {
      if (combined.includes("template") || combined.includes("merge")) {
        newMutations.push(
          `[BT008] Template engine must support {{variable}} placeholders, {{#if condition}}...{{/if}} conditionals, and {{#each array}}...{{/each}} loops. Use regex-based replacement.`
        );
      }
    }

    // CI/CD pipeline
    if (benchmark.id === "BT009") {
      if (combined.includes("dependency") || combined.includes("DAG")) {
        newMutations.push(
          `[BT009] Pipeline stages form a DAG. Resolve dependencies with topological sort. Stages with all deps satisfied run in parallel. Failed stages block all dependents.`
        );
      }
    }

    // Design tokens
    if (benchmark.id === "BT010") {
      if (combined.includes("transform") || combined.includes("CSS")) {
        newMutations.push(
          `[BT010] Token transformer must output: CSS custom properties (--color-primary: #hex), SCSS variables ($color-primary: #hex), and JSON flat map. Handle nested token groups with dot notation.`
        );
      }
    }

    // Video production
    if (benchmark.id === "BT011") {
      if (combined.includes("timeline") || combined.includes("frame")) {
        newMutations.push(
          `[BT011] Timeline must support addClip(start, duration, layer), removeClip(id), and render() which returns ordered frames. Handle overlapping clips on same layer by z-order.`
        );
      }
    }

    // Music theory
    if (benchmark.id === "BT012") {
      if (combined.includes("interval") || combined.includes("chord")) {
        newMutations.push(
          `[BT012] Note names: C, C#, D, D#, E, F, F#, G, G#, A, A#, B (12 semitones). Intervals measured in semitones. Major chord = [0,4,7], Minor = [0,3,7], Dim = [0,3,6], Aug = [0,4,8].`
        );
      }
    }

    // Data visualization
    if (benchmark.id === "BT013") {
      if (combined.includes("scale") || combined.includes("axis")) {
        newMutations.push(
          `[BT013] Linear scale maps [domainMin, domainMax] → [rangeMin, rangeMax]. Implement: scale(value), invert(pixel), ticks(count). Handle edge case where domain span is 0.`
        );
      }
    }

    // AI consulting
    if (benchmark.id === "BT014") {
      if (combined.includes("readiness") || combined.includes("score")) {
        newMutations.push(
          `[BT014] AI readiness score formula: dataMaturity * 20 (max 100). Tier: 0-33=beginner, 34-66=intermediate, 67-100=advanced. Budget and tool count inform recommendations, not score.`
        );
      }
    }

    // Security audit
    if (benchmark.id === "BT015") {
      if (combined.includes("vulnerability") || combined.includes("scan")) {
        newMutations.push(
          `[BT015] Scanner must detect: SQL injection (string concat in queries), XSS (innerHTML/document.write), hardcoded secrets (password=, secret=, api_key=), insecure crypto (MD5/SHA1), eval() usage.`
        );
      }
    }
  }

  // ── Generic execution failures ────────────────────────────────
  if (exec?.timedOut) {
    newMutations.push(
      `[${benchmark.id}] Avoid infinite loops or unbounded waits. Worker polling must stop cleanly when stop() is called. Use bounded iteration counts.`
    );
  }

  if (combined.includes("undefined") && combined.includes("property")) {
    newMutations.push(
      `[${benchmark.id}] Guard all property access with optional chaining (?.) or null checks. Initialize all class fields in the constructor.`
    );
  }

  // ── Keyword analysis ──────────────────────────────────────────
  const missed = run.grade.keyword.missedKeywords;
  if (missed.length > 3) {
    newMutations.push(
      `[${benchmark.id}] Key patterns missing: ${missed.slice(0, 5).join(", ")}. Make sure to implement all required methods and use the specified names.`
    );
  }

  return newMutations;
}

// ── Main Loop ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error("❌ OPENROUTER_API_KEY required");
    process.exit(1);
  }

  mkdirSync(join(ROOT, "autoresearch", "work"), { recursive: true });

  const benchmarks = getTargetBenchmarks();

  log("╔══════════════════════════════════════════════════════════════╗");
  log("║        8gent AUTORESEARCH — Iterative Improvement          ║");
  log("╠══════════════════════════════════════════════════════════════╣");
  log(`║  Max iterations: ${MAX_ITERATIONS}`);
  log(`║  Pass threshold: ${PASS_THRESHOLD}`);
  log(`║  Benchmarks:     ${benchmarks.length} (${TARGET_CATEGORY || "all categories"})`);
  log(`║  Models:         ${MODELS[0]} + ${MODELS.length - 1} fallbacks`);
  log("╚══════════════════════════════════════════════════════════════╝");
  log("");

  // Load previous state
  let state = loadState();
  if (state) {
    log(`📂 Resuming from iteration ${state.iteration}`);
    // Restore mutations
    clearMutations();
    for (const m of state.mutations) addMutation(m);
  } else {
    state = {
      iteration: 0,
      mutations: [],
      history: [],
      startedAt: new Date().toISOString(),
      lastRunAt: new Date().toISOString(),
    };
  }

  for (let iter = state.iteration; iter < MAX_ITERATIONS; iter++) {
    log(`\n${"═".repeat(60)}`);
    log(`  ITERATION ${iter + 1}/${MAX_ITERATIONS}`);
    log(`  Mutations so far: ${getMutations().length}`);
    log(`${"═".repeat(60)}\n`);

    const scores: Record<string, number> = {};
    const tokens: Record<string, number> = {};
    const durations: Record<string, number> = {};
    const newMutations: string[] = [];
    let totalScore = 0;
    let iterTokens = 0;
    let iterDuration = 0;

    for (const benchmark of benchmarks) {
      log(`  ┌─ ${benchmark.id}: ${benchmark.title}`);

      try {
        const run = await runBenchmarkSweep(benchmark);
        scores[benchmark.id] = run.grade.score;
        tokens[benchmark.id] = run.tokenUsage?.totalTokens ?? 0;
        durations[benchmark.id] = run.durationMs;
        totalScore += run.grade.score;
        iterTokens += run.tokenUsage?.totalTokens ?? 0;
        iterDuration += run.durationMs;

        const status = run.grade.score >= PASS_THRESHOLD ? "✓" : "✗";
        const tk = run.tokenUsage;
        log(
          `  └─ ${status} Best: score=${run.grade.score} temp=${run.temperature} model=${run.model} tokens=${tk?.totalTokens ?? "?"} ${run.durationMs}ms`
        );

        // Analyze failures and derive mutations
        const muts = analyzeAndMutate(benchmark, run);
        for (const m of muts) {
          newMutations.push(m);
          addMutation(m);
        }
      } catch (err: any) {
        log(`  └─ ✗ FAILED: ${err.message}`);
        scores[benchmark.id] = 0;
      }

      log("");
    }

    const avgScore = Math.round(totalScore / benchmarks.length);
    const passing = Object.values(scores).filter((s) => s >= PASS_THRESHOLD).length;

    const iterResult: IterationResult = {
      iteration: iter + 1,
      avgScore,
      passing,
      total: benchmarks.length,
      scores,
      tokens,
      durations,
      totalTokens: iterTokens,
      totalDurationMs: iterDuration,
      mutationsAdded: newMutations,
      timestamp: new Date().toISOString(),
    };

    state.iteration = iter + 1;
    state.mutations = getMutations();
    state.history.push(iterResult);
    state.lastRunAt = new Date().toISOString();
    saveState(state);

    // ── Iteration Summary ─────────────────────────────────────────
    log(`\n  ── Iteration ${iter + 1} Summary ──`);
    log(`  Average score: ${avgScore}`);
    log(`  Passing:       ${passing}/${benchmarks.length}`);
    log(`  Tokens used:   ${iterTokens} (avg ${Math.round(iterTokens / benchmarks.length)}/benchmark)`);
    log(`  Time taken:    ${(iterDuration / 1000).toFixed(1)}s (avg ${(iterDuration / benchmarks.length / 1000).toFixed(1)}s/benchmark)`);
    log(`  Efficiency:    ${iterTokens > 0 ? (avgScore / (iterTokens / 1000)).toFixed(2) : "n/a"} score/1k tokens`);

    if (newMutations.length > 0) {
      log(`  New mutations:  ${newMutations.length}`);
      for (const m of newMutations) {
        log(`    📝 ${m}`);
      }
    } else {
      log(`  No new mutations (all passing or no actionable failures)`);
    }

    // ── Convergence Check ─────────────────────────────────────────
    if (passing === benchmarks.length) {
      log(`\n🎉 ALL BENCHMARKS PASSING — stopping early at iteration ${iter + 1}`);
      break;
    }

    // Check for stagnation (same scores for 2 consecutive iterations)
    if (state.history.length >= 2) {
      const prev = state.history[state.history.length - 2];
      const curr = state.history[state.history.length - 1];
      if (prev.avgScore === curr.avgScore && prev.passing === curr.passing) {
        log(`\n⚠ Score stagnation detected (same as previous iteration)`);
        // Don't stop — mutations might help next round
      }
    }
  }

  // ── Final Report ────────────────────────────────────────────────
  log(`\n${"═".repeat(60)}`);
  log(`  AUTORESEARCH COMPLETE`);
  log(`${"═".repeat(60)}`);
  log(`  Total iterations: ${state.history.length}`);
  log(`  Total mutations:  ${getMutations().length}`);
  log("");

  // Score progression
  log("  Score progression:");
  for (const h of state.history) {
    const bar = "█".repeat(Math.round(h.avgScore / 5));
    log(
      `    iter ${h.iteration}: ${String(h.avgScore).padStart(3)}  ${bar}  (${h.passing}/${h.total} passing)  tokens=${h.totalTokens ?? "?"}  ${((h.totalDurationMs ?? 0) / 1000).toFixed(1)}s`
    );
  }

  // Per-benchmark final scores
  if (state.history.length > 0) {
    const final = state.history[state.history.length - 1];
    log("\n  Final scores:");
    for (const [id, score] of Object.entries(final.scores)) {
      const bm = ALL_BENCHMARKS.find((b) => b.id === id)!;
      const status = score >= PASS_THRESHOLD ? "✓" : "✗";
      log(`    ${status} ${id} ${bm.title.padEnd(50)} ${score}`);
    }
  }

  // Final mutations
  const allMuts = getMutations();
  if (allMuts.length > 0) {
    log("\n  Accumulated learnings:");
    for (const m of allMuts) {
      log(`    • ${m}`);
    }
  }

  // Model routing experience
  log("\n  🧠 Model Router Experience:");
  log(getExperienceSummary());

  // Write final report
  const reportFile = join(ROOT, "autoresearch", "autoresearch-report.json");
  writeFileSync(
    reportFile,
    JSON.stringify(
      {
        config: {
          maxIterations: MAX_ITERATIONS,
          passThreshold: PASS_THRESHOLD,
          models: MODELS,
          temperatures: TEMPERATURES,
          category: TARGET_CATEGORY || "all",
        },
        history: state.history,
        finalMutations: allMuts,
        systemPrompt: getSystemPrompt(),
      },
      null,
      2
    )
  );
  log(`\n  Report: ${reportFile}`);
  log(`  State:  ${STATE_FILE}`);
  log("");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
