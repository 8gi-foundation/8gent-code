#!/usr/bin/env bun
/**
 * 8gent Nightly Training Loop
 *
 * Runs overnight: benchmark → analyze → mutate prompt → collect training data →
 * fine-tune LoRA → create "eight" model → re-benchmark → repeat.
 *
 * Usage: bun run scripts/nightly-train.ts [--iterations 5] [--model qwen3:14b]
 */

import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  type InferenceParams,
  type RunCheckpoint,
  defaultParams,
  inferenceChat,
  adaptiveSequentialPreProcess,
  saveCheckpoint,
  loadCheckpoint,
  clearCheckpoint,
} from "../packages/orchestration/sequential-pipeline";

const PROJECT_ROOT = path.resolve(path.dirname(import.meta.dir)); // -> ~/8gent-code
const SESSIONS_DIR = path.join(os.homedir(), ".8gent", "sessions");
const CHECKPOINTS_DIR = path.join(os.homedir(), ".8gent", "checkpoints");
const TRAINING_DATA_DIR = path.join(os.homedir(), ".8gent", "training-data");
const NIGHTLY_LOG = path.join(os.homedir(), ".8gent", "nightly.log");
const SYSTEM_PROMPT_PATH = path.join(PROJECT_ROOT, "packages/eight/prompts/system-prompt.ts");
// Auto-detect bun path (local: ~/.bun/bin/bun, container: /usr/local/bin/bun)
const BUN_PATH = fs.existsSync(path.join(os.homedir(), ".bun/bin/bun"))
  ? path.join(os.homedir(), ".bun/bin/bun")
  : "/usr/local/bin/bun";
const OLLAMA_PATH = "/usr/local/bin/ollama";

// Parse args
const args = process.argv.slice(2);
const maxIterations = parseInt(args.find((_, i, a) => a[i - 1] === "--iterations") || "5");
const baseModel = args.find((_, i, a) => a[i - 1] === "--model") || "qwen3:14b";
const skipTraining = args.includes("--skip-training");
const useSequential = args.includes("--sequential");

// Ensure dirs exist
for (const dir of [SESSIONS_DIR, CHECKPOINTS_DIR, TRAINING_DATA_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(NIGHTLY_LOG, line + "\n");
}

// ============================================
// Session Persistence: checkpoint + resume on crash
// ============================================

// RunCheckpoint, saveCheckpoint, loadCheckpoint, clearCheckpoint
// are imported from packages/orchestration/sequential-pipeline

const CHECKPOINT_PATH = path.join(os.homedir(), ".8gent", "run-checkpoint.json");
const HARNESS_STATE_PATH = path.join(os.homedir(), ".8gent", "harness-state.json");

function logCheckpointResume(data: RunCheckpoint): void {
  log(`[RESUME] Found checkpoint: iter ${data.iteration}, task ${data.taskIndex}/${(data.results as unknown[]).length} completed`);
}

function loadHarnessState(): void {
  try {
    if (fs.existsSync(HARNESS_STATE_PATH)) {
      const saved = JSON.parse(fs.readFileSync(HARNESS_STATE_PATH, "utf-8"));
      Object.assign(harnessState, saved);
      log(`[RESUME] Loaded harness state: temp=${harnessState.globalTemperature}, steps=${harnessState.maxSteps}`);
    }
  } catch { /* start fresh */ }
}

function runCommand(cmd: string, args: string[], opts?: { timeout?: number; cwd?: string }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const proc = spawn(cmd, args, {
      cwd: opts?.cwd || process.cwd(),
      timeout: opts?.timeout || 300000, // 5 min default
    });
    proc.stdout?.on("data", (d) => { stdout += d.toString(); });
    proc.stderr?.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
    proc.on("error", (err) => {
      resolve({ stdout, stderr: err.message, exitCode: 1 });
    });
  });
}

// ============================================
// Sequential Multi-Inference Pipeline (Run D)
// Paper: arxiv 2603.28990v1 - fixed ordering + autonomous role selection
// Three passes: Analyst -> Critic -> Implementer
// Imported from packages/orchestration/sequential-pipeline
// ============================================

// ============================================
// Phase 1: Run Benchmarks
// ============================================

interface BenchmarkResult {
  benchmarkId: string;
  score: number;
  passed: boolean;
  error?: string;
  sessionId?: string;
}

async function runBenchmarks(model: string): Promise<BenchmarkResult[]> {
  log(`Running benchmarks with model: ${model}`);

  // ARC-AGI inspired benchmarks. Test novel reasoning, not memorized patterns.
  // Each task requires the agent to discover a hidden rule, generalize from examples,
  // and produce correct output for unseen inputs. No task is solvable by pattern matching alone.
  // Upgraded 2026-04-01 by board directive.
  const tasks = [
    { id: "ARC-pattern-induction", prompt: `Given these input-output pairs, discover the transformation rule and apply it to the test input.

Training examples:
Input 1: [[0,0,1],[0,1,0],[1,0,0]]  Output 1: [[1,0,0],[0,1,0],[0,0,1]]
Input 2: [[1,1,0],[0,0,0],[0,0,1]]  Output 2: [[0,0,1],[0,0,0],[1,1,0]]
Input 3: [[0,1,1],[1,0,0],[0,1,0]]  Output 3: [[0,1,0],[1,0,0],[0,1,1]]

Test input: [[1,0,0],[0,0,1],[0,1,0]]

Write a TypeScript function that implements the discovered rule generically (not hardcoded for these examples), apply it to the test input, and verify your answer with a test. Explain your reasoning step by step before writing code.` },

    { id: "ARC-grid-abstraction", prompt: `You are given a 5x5 grid. The rule transforms it based on a pattern you must discover.

Example 1:
Input:  [[0,0,0,0,0],[0,2,2,0,0],[0,2,0,0,0],[0,0,0,0,0],[0,0,0,0,0]]
Output: [[0,0,0,0,0],[0,2,2,0,0],[0,2,0,0,0],[0,0,0,3,0],[0,0,3,3,0]]

Example 2:
Input:  [[0,0,0,0,0],[0,0,0,0,0],[0,0,2,2,0],[0,0,0,2,0],[0,0,0,0,0]]
Output: [[0,3,0,0,0],[0,3,3,0,0],[0,0,2,2,0],[0,0,0,2,0],[0,0,0,0,0]]

Test input: [[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[2,2,0,0,0],[0,2,0,0,0]]

Discover the rule. Write TypeScript that implements it generically. Show your reasoning. Verify with tests.` },

    { id: "novel-algorithm", prompt: `Design and implement a data structure called IntervalMerger that supports these operations in better than O(n) per operation:
- add(start: number, end: number): adds an interval
- query(point: number): boolean: returns true if point is in any interval
- merge(): returns all intervals merged (overlapping intervals combined)
- remove(start: number, end: number): removes an interval range

The catch: intervals can overlap, be adjacent, or be nested. Your merge operation must handle all cases. Write implementation + comprehensive tests. Analyze the time complexity of each operation.` },

    { id: "self-modifying-system", prompt: `Build a rule engine in TypeScript where:
1. Rules are functions (condition, action) stored in a priority queue
2. Rules can ADD new rules, MODIFY existing rules, or REMOVE rules during execution
3. The engine detects infinite loops (rule A triggers rule B triggers rule A) and breaks them
4. Execution order follows priority, but newly added rules can preempt current execution

Implement the engine with: addRule, removeRule, evaluate(facts), and getExecutionTrace.
Write tests that verify: basic rule firing, priority ordering, self-modification, and loop detection.
This tests your ability to reason about recursive self-modifying systems.` },

    { id: "emergent-behavior", prompt: `Implement a cellular automaton in TypeScript with these requirements:
1. Grid is toroidal (wraps around edges)
2. Each cell has 3 possible states (0, 1, 2) instead of Conway's binary
3. Rules: a cell transitions based on the MODE (most common value) of its 8 neighbors
   - If mode is 0: cell becomes (cell + 1) % 3
   - If mode is 1: cell stays the same
   - If mode is 2: cell becomes (cell - 1 + 3) % 3
   - Ties broken by current cell value
4. Run for N generations and detect if the system reaches a cycle (repeating state)

Implement: step(), run(n), detectCycle(), and visualize() (ASCII grid output).
Write tests that verify: toroidal wrapping, state transitions, cycle detection.
Initialize with a 10x10 random grid seeded with seed=42 for reproducibility.` },
  ];

  const results: BenchmarkResult[] = [];

  // Resume from checkpoint if available
  const checkpoint = loadCheckpoint(CHECKPOINT_PATH);
  let startIndex = 0;
  if (checkpoint && checkpoint.iteration === 0) { // iteration 0 = current runBenchmarks call
    logCheckpointResume(checkpoint);
    startIndex = checkpoint.taskIndex;
    results.push(...checkpoint.results as BenchmarkResult[]);
    log(`[RESUME] Skipping ${startIndex} already-completed tasks`);
  }

  for (let ti = startIndex; ti < tasks.length; ti++) {
    const task = tasks[ti];
    log(`  Benchmark: ${task.id}`);
    try {
      // Sequential pipeline: Analyst + Critic pre-process before Implementer
      // Uses adaptive HyperAgent with retry, parameter tuning, and critic rejection
      const effectivePrompt = useSequential
        ? await adaptiveSequentialPreProcess(model, task.prompt, task.id)
        : task.prompt;

      // Determine runtime: if using model-proxy (cloud), route via openrouter
      // If local ollama model name (no slash), use ollama
      const runtime = INFERENCE_MODE === "proxy" ? "openrouter" : INFERENCE_MODE === "lmstudio" ? "lmstudio" : (model.includes("/") ? "openrouter" : "ollama");

      // LM Studio (31B local) is slower — give it 10 min per task vs 2 min for cloud/ollama
      const taskTimeout = INFERENCE_MODE === "lmstudio" ? 600000 : 120000;
      const subprocessTimeout = INFERENCE_MODE === "lmstudio" ? 660000 : 180000;
      const maxStepsForMode = INFERENCE_MODE === "lmstudio" ? 10 : (useSequential ? harnessState.maxSteps : 15);

      const result = await runCommand(BUN_PATH, [
        "run", path.join(PROJECT_ROOT, "packages/harness-cli/index.ts"), "run",
        effectivePrompt,
        "--model", model,
        "--runtime", runtime,
        "--max-steps", String(maxStepsForMode),
        "--timeout", String(taskTimeout),
        "--json",
      ], { timeout: subprocessTimeout, cwd: PROJECT_ROOT });

      let score = 0;
      let passed = false;
      let sessionId: string | undefined;
      let workdir: string | undefined;
      let sessionPath: string | undefined;

      try {
        // Parse the harness JSON output (fields: success, sessionId, sessionPath, workdir, ...)
        const jsonMatch = result.stdout.match(/\{[\s\S]*"success"[\s\S]*\}/);
        if (jsonMatch) {
          const data = JSON.parse(jsonMatch[0]);
          sessionId = data.sessionId;
          workdir = data.workdir;
          sessionPath = data.sessionPath;

          // === Multi-signal scoring (not just pass/fail) ===
          // 1. Files created in workdir (40% weight)
          let filesScore = 0;
          if (workdir && fs.existsSync(workdir)) {
            const files = fs.readdirSync(workdir).filter(f => !f.startsWith("."));
            filesScore = files.length > 0 ? 40 : 0;
          }

          // 2. Tool calls succeeded (30% weight) — parse session JSONL
          let toolsScore = 0;
          if (sessionPath && fs.existsSync(sessionPath)) {
            const sessionContent = fs.readFileSync(sessionPath, "utf-8");
            const lines = sessionContent.split("\n").filter(Boolean);
            let toolTotal = 0;
            let toolSucceeded = 0;
            for (const line of lines) {
              try {
                const entry = JSON.parse(line);
                if (entry.type === "tool_result") {
                  toolTotal++;
                  if (entry.success) toolSucceeded++;
                }
              } catch { /* skip */ }
            }
            if (toolTotal > 0) {
              toolsScore = Math.round((toolSucceeded / toolTotal) * 30);
            }
          }

          // 3. Clean exit — no errors (30% weight) — check session_end exitReason
          let exitScore = 0;
          if (sessionPath && fs.existsSync(sessionPath)) {
            const sessionContent = fs.readFileSync(sessionPath, "utf-8");
            const lines = sessionContent.split("\n").filter(Boolean);
            for (const line of lines) {
              try {
                const entry = JSON.parse(line);
                if (entry.type === "session_end") {
                  const reason = entry.summary?.exitReason;
                  // Clean exits: "natural_stop", "completed", "stop"
                  if (reason && !["error", "timeout", "crash"].includes(reason)) {
                    exitScore = 30;
                  }
                }
                // Also check for hard errors
                if (entry.type === "error" && entry.error?.recoverable === false) {
                  exitScore = 0;
                }
              } catch { /* skip */ }
            }
          }

          score = filesScore + toolsScore + exitScore;
          passed = score >= 50;
        } else {
          // No JSON output — fallback to exit code
          passed = result.exitCode === 0;
          score = passed ? 30 : 0;
        }
      } catch {
        // Parse error — fallback to exit code
        passed = result.exitCode === 0;
        score = passed ? 30 : 0;
      }

      log(`    → ${passed ? "PASS" : "FAIL"} (score: ${score})`);

      // Self-healing: if task failed, read the error, learn, retry once
      if (!passed && useSequential) {
        log(`  [HEAL] Task failed. Reading session log for error context...`);
        let failureContext = "";
        if (sessionId) {
          const failSessionPath = path.join(SESSIONS_DIR, `${sessionId}.jsonl`);
          if (fs.existsSync(failSessionPath)) {
            const lines = fs.readFileSync(failSessionPath, "utf-8").split("\n").filter(Boolean);
            // Extract last error and last assistant message
            for (const line of lines.slice(-20)) {
              try {
                const entry = JSON.parse(line);
                if (entry.type === "tool_error" || entry.type === "error") {
                  failureContext += `ERROR: ${JSON.stringify(entry.error || entry.result || "").slice(0, 300)}\n`;
                }
              } catch { /* skip */ }
            }
          }
        }
        if (!failureContext) failureContext = `Score was ${score}/100. Task did not produce passing output.`;

        log(`  [HEAL] Retrying with failure context (${failureContext.length} chars)`);

        // Build a healing prompt: original task + analyst/critic context + failure lesson
        const healPrompt = `${effectivePrompt}

--- PREVIOUS ATTEMPT FAILED ---
${failureContext}

--- HEALING DIRECTIVE ---
Your previous attempt at this task failed. Read the error above carefully.
Do NOT repeat the same approach. Identify what went wrong and try a different strategy.
Focus on getting working code with passing tests. Simplify if needed.`;

        const retryResult = await runCommand(BUN_PATH, [
          "run", path.join(PROJECT_ROOT, "packages/harness-cli/index.ts"), "run",
          healPrompt,
          "--model", model,
          "--runtime", runtime,
          "--max-steps", String(Math.min(30, maxStepsForMode + 5)),
          "--timeout", String(taskTimeout),
          "--json",
        ], { timeout: subprocessTimeout, cwd: PROJECT_ROOT });

        // Re-score the retry
        let retryScore = 0;
        let retryPassed = false;
        try {
          const jsonMatch = retryResult.stdout.match(/\{[\s\S]*"success"[\s\S]*\}/);
          if (jsonMatch) {
            const data = JSON.parse(jsonMatch[0]);
            // Same multi-signal scoring
            let filesScore = 0;
            if (data.workdir && fs.existsSync(data.workdir)) {
              const files = fs.readdirSync(data.workdir).filter((f: string) => !f.startsWith("."));
              filesScore = files.length > 0 ? 40 : 0;
            }
            let toolsScore = 0;
            if (data.sessionPath && fs.existsSync(data.sessionPath)) {
              const sc = fs.readFileSync(data.sessionPath, "utf-8").split("\n").filter(Boolean);
              let tt = 0, ts = 0;
              for (const l of sc) { try { const e = JSON.parse(l); if (e.type === "tool_result") { tt++; if (e.success) ts++; } } catch {} }
              if (tt > 0) toolsScore = Math.round((ts / tt) * 30);
            }
            let exitScore = 0;
            if (data.sessionPath && fs.existsSync(data.sessionPath)) {
              const sc = fs.readFileSync(data.sessionPath, "utf-8").split("\n").filter(Boolean);
              for (const l of sc) { try { const e = JSON.parse(l); if (e.type === "session_end") { const r = e.summary?.exitReason; if (r && !["error","timeout","crash"].includes(r)) exitScore = 30; } } catch {} }
            }
            retryScore = filesScore + toolsScore + exitScore;
            retryPassed = retryScore >= 50;
          }
        } catch { /* use defaults */ }

        if (retryScore > score) {
          log(`  [HEAL] Retry improved: ${score} → ${retryScore} ${retryPassed ? "PASS" : "FAIL"}`);
          score = retryScore;
          passed = retryPassed;
        } else {
          log(`  [HEAL] Retry did not improve: ${retryScore} (keeping original ${score})`);
        }
      }

      results.push({ benchmarkId: task.id, score, passed, sessionId });
      // Checkpoint after each task for crash recovery
      saveCheckpoint({ iteration: 0, taskIndex: ti + 1, results, startedAt: new Date().toISOString(), lastUpdated: new Date().toISOString() }, CHECKPOINT_PATH);
    } catch (err) {
      results.push({ benchmarkId: task.id, score: 0, passed: false, error: String(err) });
      log(`    → ERROR: ${err}`);
      saveCheckpoint({ iteration: 0, taskIndex: ti + 1, results, startedAt: new Date().toISOString(), lastUpdated: new Date().toISOString() }, CHECKPOINT_PATH);
    }
  }

  const avgScore = results.reduce((s, r) => s + r.score, 0) / results.length;
  const passRate = results.filter(r => r.passed).length / results.length;
  log(`Benchmark summary: avg=${avgScore.toFixed(1)}, pass=${(passRate * 100).toFixed(0)}% (${results.filter(r => r.passed).length}/${results.length})`);

  return results;
}

// ============================================
// Phase 2: Analyze + Mutate System Prompt
// ============================================

async function analyzeAndMutate(results: BenchmarkResult[], iteration: number): Promise<void> {
  const failures = results.filter(r => !r.passed);
  if (failures.length === 0) {
    log("All benchmarks passed — no mutations needed");
    return;
  }

  log(`Analyzing ${failures.length} failures for prompt mutations...`);

  // Read current system prompt
  const promptContent = fs.readFileSync(SYSTEM_PROMPT_PATH, "utf-8");

  // Build mutation based on failure patterns
  const mutations: string[] = [];

  for (const fail of failures) {
    // Read the session log if available
    if (fail.sessionId) {
      const sessionPath = path.join(SESSIONS_DIR, `${fail.sessionId}.jsonl`);
      if (fs.existsSync(sessionPath)) {
        const sessionContent = fs.readFileSync(sessionPath, "utf-8");
        const lines = sessionContent.split("\n").filter(Boolean);

        // Look for error patterns
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.type === "tool_error" || (entry.type === "tool_result" && !entry.success)) {
              const errorMsg = entry.error || entry.result || "";
              if (typeof errorMsg === "string" && errorMsg.length > 10) {
                mutations.push(`// NIGHTLY LEARNING (iter ${iteration}, benchmark ${fail.benchmarkId}): ${errorMsg.slice(0, 200)}`);
              }
            }
          } catch { /* skip */ }
        }
      }
    }

    mutations.push(`// BENCHMARK FAILURE ${fail.benchmarkId}: Score ${fail.score}. Needs improvement.`);
  }

  // Deduplicate mutations
  const uniqueMutations = [...new Set(mutations)].slice(0, 5);

  if (uniqueMutations.length > 0) {
    // DISABLED: Writing mutations to system-prompt.ts was degrading model performance.
    // 213 lines of "BENCHMARK FAILURE: needs improvement" caused scores to drop from 70 to 0.
    // Mutations now logged to a separate file for analysis without polluting the prompt.
    const mutationBlock = `ITERATION ${iteration} — ${new Date().toISOString()}\nFailures: ${failures.map(f => f.benchmarkId).join(", ")}\n${uniqueMutations.join("\n")}\n---\n`;
    const learningsPath = path.join(os.homedir(), ".8gent", "benchmark-learnings.log");
    fs.appendFileSync(learningsPath, mutationBlock);
    log(`Logged ${uniqueMutations.length} learnings to benchmark-learnings.log (prompt NOT modified)`);
  }
}

// ============================================
// Phase 2b: Post failures to Discord boardroom for collective deliberation
// ============================================

const DISCORD_BOARDROOM_CHANNEL = "1487059185299357797";
const DISCORD_BOT_TOKEN_8EO = process.env.DISCORD_TOKEN_8EO || "";

async function postToBoardroom(results: BenchmarkResult[], iteration: number): Promise<void> {
  if (!DISCORD_BOT_TOKEN_8EO) {
    log("No Discord token — skipping boardroom post");
    return;
  }

  const failures = results.filter(r => !r.passed);
  if (failures.length === 0) return;

  const failureList = failures.map(f =>
    `- **${f.benchmarkId}**: score ${f.score}${f.error ? ` (${f.error.slice(0, 100)})` : ""}`
  ).join("\n");

  const avgScore = results.reduce((s, r) => s + r.score, 0) / results.length;
  const passCount = results.filter(r => r.passed).length;

  const message = [
    `**AUTORESEARCH ITER ${iteration}** | Avg: ${avgScore.toFixed(0)} | Pass: ${passCount}/${results.length}`,
    "",
    "**Failures needing collective review:**",
    failureList,
    "",
    "<@8TO> what engineering approach would improve these scores?",
    "<@8SO> are there security implications in the failure patterns?",
    "<@8PO> which failures matter most for the user experience?",
    "",
    "*Deliberate here. Learnings will feed into the next iteration.*",
  ].join("\n");

  // Truncate to Discord limit
  const truncated = message.length > 1900 ? message.slice(0, 1900) + "..." : message;

  try {
    const res = await fetch(`https://discord.com/api/v10/channels/${DISCORD_BOARDROOM_CHANNEL}/messages`, {
      method: "POST",
      headers: {
        "Authorization": `Bot ${DISCORD_BOT_TOKEN_8EO}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: truncated }),
    });

    if (res.ok) {
      log(`Posted ${failures.length} failures to #boardroom for deliberation`);
    } else {
      log(`Boardroom post failed: ${res.status} ${res.statusText}`);
    }
  } catch (err) {
    log(`Boardroom post error: ${err}`);
  }
}

// ============================================
// Phase 2c: Send Telegram update
// ============================================

const TELEGRAM_BOT_TOKEN = "8064662731:AAEJ8bDvY9zpxP9ieBU2tBfcpCX81YkDyIs";
const TELEGRAM_CHAT_ID = "5486040131";

async function sendTelegramUpdate(results: BenchmarkResult[], iteration: number, maxIterations: number): Promise<void> {
  const avgScore = results.reduce((s, r) => s + r.score, 0) / results.length;
  const passCount = results.filter(r => r.passed).length;
  const passRate = ((passCount / results.length) * 100).toFixed(0);

  // Determine environment
  const location = INFERENCE_MODE === "proxy" ? "Cloud (Amsterdam)" : INFERENCE_MODE === "lmstudio" ? "Local (LM Studio / Gemma 4)" : "Local (Ollama)";
  const model = baseModel;

  const resultLines = results.map(r => {
    const icon = r.passed ? "✅" : (r.score > 0 ? "⚠️" : "❌");
    return `${icon} ${r.benchmarkId}: ${r.score}`;
  }).join("\n");

  // Performance commentary
  let commentary = "";
  if (passCount === results.length) commentary = "PERFECT SCORE. All tasks passed.";
  else if (passCount >= 4) commentary = "Strong run. Nearly perfect.";
  else if (passCount >= 2) commentary = "Mixed results. HyperAgent adapting.";
  else if (passCount === 1) commentary = "Struggling. Self-healing active.";
  else commentary = "All failed. Major adaptation needed.";

  const text = [
    `🔬 *AUTORESEARCH #${iteration}/${maxIterations}*`,
    "",
    `*Model:* ${model}`,
    `*Where:* ${location}`,
    `*Vessel:* ${VESSEL_ID}`,
    `*Temp:* ${harnessState.globalTemperature} | *Steps:* ${harnessState.maxSteps}`,
    "",
    `*Result: ${passRate}% (${passCount}/${results.length})* | Avg: ${avgScore.toFixed(0)}`,
    "",
    resultLines,
    "",
    `💬 _${commentary}_`,
    "",
    `_Iteration ${iteration < maxIterations ? iteration + 1 : "complete"}${iteration < maxIterations ? " starting..." : ". Falling back to daemon."}_`,
  ].join("\n");

  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        parse_mode: "Markdown",
        text,
      }),
    });
  } catch { /* best effort */ }
}

// ============================================
// HyperAgent: Inter-iteration self-improvement
// Learns from results, adjusts strategy for next iteration
// ============================================

interface HarnessState {
  taskPerformance: Record<string, { bestScore: number; bestStrategy: string; failCount: number }>;
  globalTemperature: number;
  maxSteps: number;
}

const harnessState: HarnessState = {
  taskPerformance: {},
  globalTemperature: 0.7,
  maxSteps: 15,
};

function selfImprove(results: BenchmarkResult[], iteration: number): void {
  log(`  [HYPER] Self-improvement analysis for iteration ${iteration}`);

  const avgScore = results.reduce((s, r) => s + r.score, 0) / results.length;
  const passRate = results.filter(r => r.passed).length / results.length;

  // Track per-task performance
  for (const r of results) {
    const prev = harnessState.taskPerformance[r.benchmarkId];
    if (!prev || r.score > prev.bestScore) {
      harnessState.taskPerformance[r.benchmarkId] = {
        bestScore: r.score,
        bestStrategy: useSequential ? "sequential" : "direct",
        failCount: r.passed ? 0 : (prev?.failCount || 0) + 1,
      };
    } else if (!r.passed) {
      harnessState.taskPerformance[r.benchmarkId] = {
        ...prev,
        failCount: prev.failCount + 1,
      };
    }
  }

  // Adaptive temperature: if pass rate is low, try higher temperature for diversity
  if (passRate < 0.4) {
    harnessState.globalTemperature = Math.min(0.95, harnessState.globalTemperature + 0.05);
    log(`  [HYPER] Low pass rate (${(passRate * 100).toFixed(0)}%) - raising temperature to ${harnessState.globalTemperature}`);
  } else if (passRate > 0.6) {
    harnessState.globalTemperature = Math.max(0.5, harnessState.globalTemperature - 0.05);
    log(`  [HYPER] Good pass rate (${(passRate * 100).toFixed(0)}%) - lowering temperature to ${harnessState.globalTemperature} for consistency`);
  }

  // Adaptive max steps: if pass rate is low, give more steps for implementation
  if (passRate < 0.4 && harnessState.maxSteps < 30) {
    harnessState.maxSteps = Math.min(30, harnessState.maxSteps + 5);
    log(`  [HYPER] Low pass rate with rich analysis - increasing max steps to ${harnessState.maxSteps}`);
  } else if (passRate > 0.8 && harnessState.maxSteps > 15) {
    harnessState.maxSteps = Math.max(15, harnessState.maxSteps - 5);
    log(`  [HYPER] High pass rate - reducing max steps to ${harnessState.maxSteps} for efficiency`);
  }

  // Log the harness state for analysis
  const stateLog = JSON.stringify(harnessState, null, 2);
  const statePath = path.join(os.homedir(), ".8gent", "harness-state.json");
  fs.writeFileSync(statePath, stateLog);
  log(`  [HYPER] State saved to ${statePath}`);
}

// ============================================
// Phase 3: Collect Training Data
// ============================================

async function collectTrainingData(results: BenchmarkResult[], iteration: number): Promise<string | null> {
  log("Collecting training data from sessions...");

  const trainingPairs: Array<{ prompt: string; chosen: string; rejected: string }> = [];

  // Collect from all recent sessions
  const sessionFiles = fs.readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith(".jsonl"))
    .sort()
    .slice(-20); // Last 20 sessions

  for (const file of sessionFiles) {
    const content = fs.readFileSync(path.join(SESSIONS_DIR, file), "utf-8");
    const lines = content.split("\n").filter(Boolean);

    let currentPrompt = "";
    let currentResponse = "";
    let hasError = false;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === "user_message" && entry.message?.content) {
          // Save previous pair if exists
          if (currentPrompt && currentResponse) {
            if (!hasError) {
              trainingPairs.push({
                prompt: currentPrompt,
                chosen: currentResponse,
                rejected: "", // Will be filled from failed attempts
              });
            }
          }
          currentPrompt = entry.message.content;
          currentResponse = "";
          hasError = false;
        }
        if (entry.type === "assistant_message" && entry.message?.content) {
          currentResponse = entry.message.content;
        }
        if (entry.type === "assistant_content" && entry.parts) {
          const textParts = entry.parts.filter((p: any) => p.type === "text");
          if (textParts.length > 0) {
            currentResponse = textParts.map((p: any) => p.text).join("\n");
          }
        }
        if (entry.type === "tool_error" || (entry.type === "error")) {
          hasError = true;
        }
      } catch { /* skip */ }
    }
  }

  if (trainingPairs.length === 0) {
    log("No training pairs collected — need more session data");
    return null;
  }

  // Write training data as JSONL
  const dataPath = path.join(TRAINING_DATA_DIR, `training_iter${iteration}_${Date.now()}.jsonl`);
  const jsonlContent = trainingPairs
    .filter(p => p.prompt.length > 10 && p.chosen.length > 10)
    .map(p => JSON.stringify(p))
    .join("\n");

  fs.writeFileSync(dataPath, jsonlContent);
  log(`Collected ${trainingPairs.length} training pairs → ${dataPath}`);

  return dataPath;
}

// ============================================
// Phase 4: Fine-tune LoRA → Create "eight" model
// ============================================

async function trainLoRA(dataPath: string, iteration: number): Promise<string | null> {
  log(`Starting LoRA fine-tuning (iteration ${iteration})...`);

  const outputDir = path.join(CHECKPOINTS_DIR, `eight_iter${iteration}_${Date.now()}`);

  const result = await runCommand("python3", [
    path.join(PROJECT_ROOT, "packages/kernel/train_lora.py"),
    "--data", dataPath,
    "--base-model", "Qwen/Qwen2.5-Coder-14B", // HuggingFace model ID
    "--output", outputDir,
    "--epochs", "1",
    "--lora-rank", "16",
  ], { timeout: 600000, cwd: PROJECT_ROOT }); // 10 min timeout for training

  if (result.exitCode !== 0) {
    log(`LoRA training failed: ${result.stderr.slice(-500)}`);
    return null;
  }

  log(`LoRA checkpoint saved: ${outputDir}`);
  return outputDir;
}

async function createOllamaModel(checkpointDir: string, iteration: number): Promise<boolean> {
  log("Creating 'eight' model in Ollama...");

  // Create a Modelfile that references the base model + LoRA adapter
  const modelfilePath = path.join(checkpointDir, "Modelfile");
  const modelfileContent = `FROM qwen3:14b
ADAPTER ${path.join(checkpointDir, "adapter")}
PARAMETER temperature 0.7
PARAMETER top_p 0.9
SYSTEM """You are Eight, a fine-tuned coding agent. You execute tasks efficiently using tools."""
`;

  // Check if adapter files exist
  const adapterPath = path.join(checkpointDir, "adapter");
  if (!fs.existsSync(adapterPath)) {
    // If no adapter directory, create model without adapter (just custom system prompt)
    const simpleModelfile = `FROM qwen3:14b
PARAMETER temperature 0.7
PARAMETER top_p 0.9
SYSTEM """You are Eight — 8gent's fine-tuned model, iteration ${iteration}. You are a direct executor: you DO things using tools, never explain how. You own your architecture with class. Dry British wit, efficient, no filler words."""
`;
    fs.writeFileSync(modelfilePath, simpleModelfile);
  } else {
    fs.writeFileSync(modelfilePath, modelfileContent);
  }

  // Naming convention: eight-{iteration}-q-14b (q = qwen lineage, 14b = params)
  const modelName = `eight-${iteration}-q-14b`;
  const result = await runCommand(OLLAMA_PATH, ["create", modelName, "-f", modelfilePath], { timeout: 120000 });

  if (result.exitCode !== 0) {
    log(`Failed to create Ollama model: ${result.stderr.slice(-300)}`);
    return false;
  }

  log("Model 'eight' created in Ollama!");
  return true;
}

// ============================================
// Main Loop
// ============================================

async function main() {
  log("═══════════════════════════════════════════════════");
  log("8gent Nightly Training Loop — Starting");
  log(`Base model: ${baseModel}`);
  log(`Max iterations: ${maxIterations}`);
  log(`Skip training: ${skipTraining}`);
  log(`Sequential pipeline (Run D): ${useSequential}`);
  log("═══════════════════════════════════════════════════");

  // Load persisted harness state from previous runs (survives crashes)
  loadHarnessState();

  let currentModel = baseModel;
  const allResults: Array<{ iteration: number; results: BenchmarkResult[]; model: string }> = [];

  for (let i = 1; i <= maxIterations; i++) {
    log(`\n─── Iteration ${i}/${maxIterations} ───────────────────────`);

    // Phase 1: Benchmark (resumes from checkpoint if crashed mid-iteration)
    const results = await runBenchmarks(currentModel);
    allResults.push({ iteration: i, results, model: currentModel });
    clearCheckpoint(CHECKPOINT_PATH); // Iteration complete, clear checkpoint

    // Phase 2: Analyze + Mutate
    await analyzeAndMutate(results, i);

    // Phase 2b: Post failures to Discord boardroom for collective deliberation
    await postToBoardroom(results, i);

    // Phase 2c: Send Telegram update
    await sendTelegramUpdate(results, i, maxIterations);

    // Phase 2d: HyperAgent self-improvement (adjusts params for next iteration)
    if (useSequential) {
      selfImprove(results, i);
    }

    // Phase 3: Collect training data
    const dataPath = await collectTrainingData(results, i);

    // Phase 4: Train + Create model (if we have data and not skipping)
    // NOTE: Model switching disabled. Previous runs showed persona-tuned models
    // degrade performance (Opus-4B: 0% pass despite high process scores).
    // Keep base model throughout all iterations for consistent results.
    if (dataPath && !skipTraining) {
      const checkpoint = await trainLoRA(dataPath, i);
      if (checkpoint) {
        const created = await createOllamaModel(checkpoint, i);
        if (created) {
          log("LoRA model created but NOT switching - keeping base model for consistency");
        }
      }
    }

    // Brief pause between iterations
    await new Promise(r => setTimeout(r, 5000));
  }

  // Phase 5: Social Feed Research — browse feeds for patterns to absorb
  log("\n─── Social Feed Research ──────────────────────────");
  try {
    const { runSocialResearch } = await import("./social-feed-research");
    const research = await runSocialResearch();
    log(`Social research: ${research.findings.length} findings, ${research.issues.length} issues created`);
  } catch (err) {
    log(`Social research failed (non-fatal): ${err}`);
  }

  // Final summary
  log("\n═══════════════════════════════════════════════════");
  log("Nightly Training Complete — Summary");
  log("═══════════════════════════════════════════════════");

  for (const { iteration, results, model } of allResults) {
    const avg = results.reduce((s, r) => s + r.score, 0) / results.length;
    const passed = results.filter(r => r.passed).length;
    log(`Iteration ${iteration} (${model}): avg=${avg.toFixed(1)}, pass=${passed}/${results.length}`);
  }

  // Check if model exists
  const ollamaList = await runCommand(OLLAMA_PATH, ["list"]);
  if (ollamaList.stdout.includes("eight")) {
    log("\n✅ Model 'eight' is registered in Ollama and ready to use!");
    log("   Switch with: /model eight");
  }

  log("\n🎯 COMPLETED: Nightly training finished. The Infinite Gentleman grows wiser in his sleep.");
}

main().catch((err) => {
  log(`FATAL: ${err}`);
  process.exit(1);
});
