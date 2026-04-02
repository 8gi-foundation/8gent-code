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

interface RunCheckpoint {
  iteration: number;
  taskIndex: number;
  results: BenchmarkResult[];
  startedAt: string;
  lastUpdated: string;
}

const CHECKPOINT_PATH = path.join(os.homedir(), ".8gent", "run-checkpoint.json");
const HARNESS_STATE_PATH = path.join(os.homedir(), ".8gent", "harness-state.json");

function saveCheckpoint(cp: RunCheckpoint): void {
  fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(cp, null, 2));
}

function loadCheckpoint(): RunCheckpoint | null {
  try {
    if (fs.existsSync(CHECKPOINT_PATH)) {
      const data = JSON.parse(fs.readFileSync(CHECKPOINT_PATH, "utf-8"));
      log(`[RESUME] Found checkpoint: iter ${data.iteration}, task ${data.taskIndex}/${data.results.length} completed`);
      return data;
    }
  } catch { /* corrupted checkpoint, start fresh */ }
  return null;
}

function clearCheckpoint(): void {
  try { fs.unlinkSync(CHECKPOINT_PATH); } catch { /* ok */ }
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
// ============================================

// Adaptive parameters - the harness tunes these at runtime
interface InferenceParams {
  temperature: number;
  num_predict: number;
  timeout: number;
}

function defaultParams(promptLength: number): InferenceParams {
  // Adaptive timeout: longer prompts need more thinking time
  // qwen3 thinking mode: ~1 token/30ms thinking + ~1 token/30ms content
  const baseTimeout = 180000; // 3 min minimum
  const perCharTimeout = Math.min(promptLength * 50, 420000); // scale with prompt, cap at 7 min extra
  return {
    temperature: 0.7,
    num_predict: 8192,
    timeout: baseTimeout + perCharTimeout,
  };
}

// Auto-detect inference backend: model-proxy (cloud) or Ollama (local)
const INFERENCE_MODE = process.env.INFERENCE_MODE || "ollama";
const MODEL_PROXY_URL = process.env.MODEL_PROXY_URL || "http://8gi-model-proxy.internal:3200";
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";
const VESSEL_ID = process.env.BOARD_MEMBER_CODE || "local";

async function inferenceChat(model: string, systemPrompt: string, userPrompt: string, params?: Partial<InferenceParams>): Promise<{ content: string; durationMs: number }> {
  const p = { ...defaultParams(userPrompt.length), ...params };
  const start = Date.now();

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), p.timeout);

    let content = "";

    if (INFERENCE_MODE === "proxy") {
      // Cloud mode: use model-proxy (OpenAI-compatible)
      const proxyKey = process.env.PROXY_API_KEY || process.env.OPENROUTER_API_KEY || process.env.DAEMON_AUTH_TOKEN || "";
      const res = await fetch(`${MODEL_PROXY_URL}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${proxyKey}`,
          "X-Vessel-ID": VESSEL_ID,
          "X-User-Id": VESSEL_ID,
        },
        body: JSON.stringify({
          model: model === "qwen3:14b" ? "auto:free" : model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          max_tokens: p.num_predict,
          temperature: p.temperature,
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const data = await res.json() as any;
      content = data.choices?.[0]?.message?.content || "";
    } else {
      // Local mode: use Ollama directly
      const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          stream: false,
          options: { temperature: p.temperature, num_predict: p.num_predict },
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const data = await res.json() as any;
      content = data.message?.content || "";
    }

    return { content, durationMs: Date.now() - start };
  } catch (err) {
    log(`    inferenceChat error: ${err}`);
    return { content: "", durationMs: Date.now() - start };
  }
}

// ============================================
// Adaptive HyperAgent: self-improving sequential pipeline
// Strategy: Analyst -> Critic (no-BS) -> retry if rejected -> Implementer
// Self-adjusts: timeout, temperature, retries based on results
// ============================================

const MAX_ANALYST_RETRIES = 2;

async function adaptiveSequentialPreProcess(model: string, taskPrompt: string, taskId: string): Promise<string> {
  // --- Pass 1: Analyst (with retry on empty/timeout) ---
  let analysis = "";
  let analystAttempt = 0;
  let analystParams: Partial<InferenceParams> = {};

  while (analystAttempt < MAX_ANALYST_RETRIES && !analysis) {
    analystAttempt++;
    if (analystAttempt > 1) {
      // Self-improve: increase timeout, raise temperature for diversity
      analystParams = {
        timeout: (analystParams.timeout || defaultParams(taskPrompt.length).timeout) * 1.5,
        temperature: Math.min(0.9, (analystParams.temperature || 0.7) + 0.1),
      };
      log(`  [HYPER] Analyst retry ${analystAttempt} - timeout: ${Math.round((analystParams.timeout || 0) / 1000)}s, temp: ${analystParams.temperature}`);
    }

    log(`  [SEQ] Pass 1: Analyst for ${taskId} (attempt ${analystAttempt})`);
    const result = await inferenceChat(model,
      `You are an Analyst. Your ONLY job is to identify the transformation rule or algorithm required.
Be precise. State the rule in formal terms. Do NOT write code. Do NOT implement anything.
Keep your response under 500 words.
Output format:
RULE: <one sentence formal description>
EVIDENCE: <which examples prove this rule>
EDGE CASES: <what could go wrong>`,
      taskPrompt,
      analystParams
    );
    analysis = result.content;
    log(`  [SEQ] Pass 1 complete (${analysis.length} chars, ${Math.round(result.durationMs / 1000)}s)`);
  }

  if (!analysis) {
    log(`  [HYPER] Analyst failed after ${MAX_ANALYST_RETRIES} attempts - falling back to direct mode`);
    return taskPrompt; // Fall back to non-sequential mode
  }

  // --- Pass 2: Critic (no-BS mode) ---
  log(`  [SEQ] Pass 2: Critic for ${taskId}`);
  const critiqueResult = await inferenceChat(model,
    `You are a Critic operating in no-BS mode. You receive an Analyst's rule identification and the original problem.
Your ONLY job is to find flaws, missed cases, or errors in the analysis.
Be harsh. Be specific. Do not let sloppy analysis pass.
If the analysis is WRONG, say REJECTED and explain why.
If the analysis is CORRECT, say APPROVED and list implementation pitfalls.
Keep your response under 300 words.
Output format:
VERDICT: APPROVED or REJECTED
FLAWS: <list specific errors or gaps, or "None" if approved>
CORRECTIONS: <what the rule actually is, if different>
IMPLEMENTATION RISKS: <what will go wrong when coding this>`,
    `ORIGINAL PROBLEM:\n${taskPrompt}\n\nANALYST OUTPUT:\n${analysis}`
  );

  const critique = critiqueResult.content;
  log(`  [SEQ] Pass 2 complete (${critique.length} chars, ${Math.round(critiqueResult.durationMs / 1000)}s)`);

  // --- Critic rejection triggers analyst retry ---
  if (critique.includes("REJECTED") && analystAttempt < MAX_ANALYST_RETRIES) {
    log(`  [HYPER] Critic REJECTED analysis - retrying analyst with critique feedback`);
    const retryResult = await inferenceChat(model,
      `You are an Analyst. Your previous analysis was REJECTED by a critic.
Read the critic's feedback carefully and provide a corrected analysis.
Be precise. State the rule in formal terms. Do NOT write code.
Keep your response under 500 words.
Output format:
RULE: <corrected one sentence formal description>
EVIDENCE: <which examples prove this rule>
EDGE CASES: <what could go wrong>`,
      `ORIGINAL PROBLEM:\n${taskPrompt}\n\nYOUR PREVIOUS ANALYSIS:\n${analysis}\n\nCRITIC FEEDBACK:\n${critique}`,
      { temperature: 0.5 } // Lower temp for corrected analysis
    );

    if (retryResult.content) {
      log(`  [HYPER] Analyst correction complete (${retryResult.content.length} chars, ${Math.round(retryResult.durationMs / 1000)}s)`);
      analysis = retryResult.content;
    }
  }

  // --- Build enhanced prompt for Implementer ---
  const enhancedPrompt = `${taskPrompt}

--- ANALYST REPORT ---
${analysis}

--- CRITIC REVIEW ---
${critique}

--- IMPLEMENTATION DIRECTIVE ---
You have received analysis and critique from two prior reviewers. Use their insights to write a correct implementation. If the critic found flaws in the analysis, trust the critic's corrections. Write the code, run tests, verify correctness.`;

  return enhancedPrompt;
}

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
  const checkpoint = loadCheckpoint();
  let startIndex = 0;
  if (checkpoint && checkpoint.iteration === 0) { // iteration 0 = current runBenchmarks call
    startIndex = checkpoint.taskIndex;
    results.push(...checkpoint.results);
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
      const runtime = INFERENCE_MODE === "proxy" ? "openrouter" : (model.includes("/") ? "openrouter" : "ollama");

      const result = await runCommand(BUN_PATH, [
        "run", path.join(PROJECT_ROOT, "packages/harness-cli/index.ts"), "run",
        effectivePrompt,
        "--model", model,
        "--runtime", runtime,
        "--max-steps", String(useSequential ? harnessState.maxSteps : 15),
        "--timeout", "120000",
        "--json",
      ], { timeout: 180000, cwd: PROJECT_ROOT });

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

      results.push({ benchmarkId: task.id, score, passed, sessionId });
      log(`    → ${passed ? "PASS" : "FAIL"} (score: ${score})`);
      // Checkpoint after each task for crash recovery
      saveCheckpoint({ iteration: 0, taskIndex: ti + 1, results, startedAt: new Date().toISOString(), lastUpdated: new Date().toISOString() });
    } catch (err) {
      results.push({ benchmarkId: task.id, score: 0, passed: false, error: String(err) });
      log(`    → ERROR: ${err}`);
      saveCheckpoint({ iteration: 0, taskIndex: ti + 1, results, startedAt: new Date().toISOString(), lastUpdated: new Date().toISOString() });
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

  const resultLines = results.map(r => {
    const icon = r.passed ? "✅" : (r.score > 0 ? "⚠️" : "❌");
    return `${icon} ${r.benchmarkId}: ${r.score}`;
  }).join("\n");

  const text = [
    `🔬 *ARC-AGI AUTORESEARCH #${iteration}/${maxIterations}*`,
    `Avg: *${avgScore.toFixed(0)}* | Pass: *${passCount}/${results.length}*`,
    "",
    resultLines,
    "",
    `_Next iteration in 2 min_`,
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
    clearCheckpoint(); // Iteration complete, clear checkpoint

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
