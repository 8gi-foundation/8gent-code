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
const BUN_PATH = path.join(os.homedir(), ".bun/bin/bun");
const OLLAMA_PATH = "/usr/local/bin/ollama";

// Parse args
const args = process.argv.slice(2);
const maxIterations = parseInt(args.find((_, i, a) => a[i - 1] === "--iterations") || "5");
const baseModel = args.find((_, i, a) => a[i - 1] === "--model") || "qwen3:14b";
const skipTraining = args.includes("--skip-training");

// Ensure dirs exist
for (const dir of [SESSIONS_DIR, CHECKPOINTS_DIR, TRAINING_DATA_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(NIGHTLY_LOG, line + "\n");
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

  // Use the harness CLI to run a subset of benchmarks
  const tasks = [
    { id: "fib", prompt: "Write a fibonacci function in TypeScript that returns the nth fibonacci number. Handle edge cases (n=0 returns 0, n=1 returns 1, negative n throws)." },
    { id: "sort", prompt: "Write a merge sort function in TypeScript: function mergeSort(arr: number[]): number[]. Must be stable sort, handle empty arrays and single elements." },
    { id: "cache", prompt: "Write an LRU cache class in TypeScript with get(key), set(key, value), and a maxSize constructor param. Use Map for O(1) operations." },
    { id: "validate", prompt: "Write a function validateEmail(email: string): boolean that checks for valid email format. Must handle edge cases: no @, multiple @, no domain, no TLD." },
    { id: "parse", prompt: "Write a function parseQueryString(qs: string): Record<string, string> that parses URL query strings like '?foo=bar&baz=qux'. Handle encoded values with decodeURIComponent." },
  ];

  const results: BenchmarkResult[] = [];

  for (const task of tasks) {
    log(`  Benchmark: ${task.id}`);
    try {
      const result = await runCommand(BUN_PATH, [
        "run", path.join(PROJECT_ROOT, "packages/harness-cli/index.ts"), "run",
        task.prompt,
        "--model", model,
        "--runtime", model.includes("/") ? "openrouter" : "ollama",
        "--max-steps", "15",
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
    } catch (err) {
      results.push({ benchmarkId: task.id, score: 0, passed: false, error: String(err) });
      log(`    → ERROR: ${err}`);
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
    // Append mutations as a new section in the system prompt
    const mutationBlock = `
// NIGHTLY TRAINING ITERATION ${iteration} — ${new Date().toISOString()}
// Failures: ${failures.map(f => f.benchmarkId).join(", ")}
${uniqueMutations.join("\n")}
`;

    // Check if there's already a nightly section and append
    if (promptContent.includes("// NIGHTLY TRAINING ITERATION")) {
      // Append after the last nightly section
      const lastIndex = promptContent.lastIndexOf("// NIGHTLY TRAINING ITERATION");
      const nextNewlineAfterBlock = promptContent.indexOf("\n\n", lastIndex + 50);
      const insertPoint = nextNewlineAfterBlock > 0 ? nextNewlineAfterBlock : promptContent.length;

      const updated = promptContent.slice(0, insertPoint) + "\n" + mutationBlock + promptContent.slice(insertPoint);
      fs.writeFileSync(SYSTEM_PROMPT_PATH, updated);
    } else {
      // Add before the last export
      const lastExportIndex = promptContent.lastIndexOf("export ");
      if (lastExportIndex > 0) {
        const updated = promptContent.slice(0, lastExportIndex) + mutationBlock + "\n" + promptContent.slice(lastExportIndex);
        fs.writeFileSync(SYSTEM_PROMPT_PATH, updated);
      }
    }

    log(`Applied ${uniqueMutations.length} prompt mutations`);
  }
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
  log("═══════════════════════════════════════════════════");

  let currentModel = baseModel;
  const allResults: Array<{ iteration: number; results: BenchmarkResult[]; model: string }> = [];

  for (let i = 1; i <= maxIterations; i++) {
    log(`\n─── Iteration ${i}/${maxIterations} ───────────────────────`);

    // Phase 1: Benchmark
    const results = await runBenchmarks(currentModel);
    allResults.push({ iteration: i, results, model: currentModel });

    // Phase 2: Analyze + Mutate
    await analyzeAndMutate(results, i);

    // Phase 3: Collect training data
    const dataPath = await collectTrainingData(results, i);

    // Phase 4: Train + Create model (if we have data and not skipping)
    if (dataPath && !skipTraining) {
      const checkpoint = await trainLoRA(dataPath, i);
      if (checkpoint) {
        const created = await createOllamaModel(checkpoint, i);
        if (created) {
          currentModel = "eight";
          log("Switched to model 'eight' for next iteration");
        }
      }
    } else if (i === 1) {
      // On first iteration, create "eight" as a persona-tuned version even without LoRA
      const simpleCheckpoint = path.join(CHECKPOINTS_DIR, `eight_persona_${Date.now()}`);
      fs.mkdirSync(simpleCheckpoint, { recursive: true });
      await createOllamaModel(simpleCheckpoint, i);
      currentModel = "eight";
      log("Created 'eight' persona model (no LoRA yet, just system prompt tuning)");
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
