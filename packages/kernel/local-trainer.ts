/**
 * Local LoRA Training Backend for MetaClaw
 *
 * Runs entirely on Apple M2 Max — no cloud services.
 * Collects GRPO pairs from session data, trains LoRA adapters
 * via a Python script (peft/unsloth on MPS), validates checkpoints,
 * and hot-swaps adapters into Ollama.
 */

import { spawn } from "bun";
import {
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import type { ScoreRecord } from "./judge";
import type { CheckpointInfo } from "./training";

// ── Types ────────────────────────────────────────────────────────────

export interface LocalTrainerConfig {
  /** Base model for LoRA training (HuggingFace ID) */
  baseModelHf: string;
  /** Ollama model name for serving */
  ollamaModel: string;
  /** LoRA rank (default: 32) */
  loraRank: number;
  /** Training epochs per run (default: 3) */
  epochs: number;
  /** Learning rate (default: 2e-4) */
  learningRate: number;
  /** Batch size (default: 1 for M2 Max) */
  batchSize: number;
  /** Min samples before training triggers (default: 8) */
  minSamplesForTraining: number;
  /** Score threshold: "good" response (default: 0.7) */
  goodScoreThreshold: number;
  /** Score threshold: "bad" response (default: 0.3) */
  badScoreThreshold: number;
  /** Session data search paths */
  sessionPaths: string[];
  /** Checkpoint output root */
  checkpointDir: string;
  /** GRPO pairs data directory */
  dataDir: string;
  /** Benchmark validation command */
  validateCommand: string;
  /** Min benchmark score to promote (default: 80) */
  promotionThreshold: number;
  /** Path to the Python training script */
  trainerScript: string;
  /** Preferred backend: auto, unsloth, peft */
  backend: "auto" | "unsloth" | "peft";
}

interface GrpoPair {
  prompt: string;
  chosen: string;
  rejected: string;
  chosen_score: number;
  rejected_score: number;
  session_id: string;
  collected_at: string;
}

interface SessionTurn {
  type: string;
  timestamp: string;
  sequenceNumber: number;
  message?: { role: string; content: string };
  toolCall?: { name: string; arguments: Record<string, unknown> };
  toolResult?: { result: string };
  stepNumber?: number;
}

interface LocalTrainerState {
  /** Unpaired "good" responses waiting for a matching "bad" pair */
  pendingGood: Array<{ prompt: string; response: string; score: number; sessionId: string }>;
  /** Unpaired "bad" responses waiting for a matching "good" pair */
  pendingBad: Array<{ prompt: string; response: string; score: number; sessionId: string }>;
  /** Collected GRPO pairs ready for training */
  grpoPairs: GrpoPair[];
  /** All checkpoint metadata */
  checkpoints: CheckpointInfo[];
  /** Currently active (promoted) checkpoint */
  activeCheckpointId: string | null;
  /** Total pairs ever collected */
  totalPairsCollected: number;
  /** Total training runs */
  totalRuns: number;
  /** Last updated */
  updatedAt: string;
}

// ── Defaults ─────────────────────────────────────────────────────────

const HOME = homedir();
const KERNEL_DIR = join(HOME, ".8gent", "kernel");

const DEFAULT_CONFIG: LocalTrainerConfig = {
  baseModelHf: "Qwen/Qwen3-14B",
  ollamaModel: "qwen3:14b",
  loraRank: 32,
  epochs: 3,
  learningRate: 2e-4,
  batchSize: 1,
  minSamplesForTraining: 8,
  goodScoreThreshold: 0.7,
  badScoreThreshold: 0.3,
  sessionPaths: [
    join(HOME, ".metaclaw", "data"),
    join(HOME, ".8gent", "sessions"),
  ],
  checkpointDir: join(HOME, ".8gent", "checkpoints"),
  dataDir: join(KERNEL_DIR, "training"),
  validateCommand: "bun run benchmarks/autoresearch/validate-checkpoint.ts",
  promotionThreshold: 80,
  trainerScript: join(dirname(new URL(import.meta.url).pathname), "train_lora.py"),
  backend: "auto",
};

// ── LocalTrainer ─────────────────────────────────────────────────────

export class LocalTrainer {
  private config: LocalTrainerConfig;
  private state: LocalTrainerState;
  private isTraining = false;

  constructor(config: Partial<LocalTrainerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.ensureDirs();
    this.state = this.loadState();
  }

  // ── Data Collection ──────────────────────────────────────────────

  /**
   * Ingest a scored agent response. Collects into GRPO pairs
   * by matching good/bad responses to the same prompt category.
   * Returns true if a training run was triggered.
   */
  async ingestScore(record: ScoreRecord): Promise<boolean> {
    const score = record.scores.overall;
    const entry = {
      prompt: record.prompt,
      response: record.response,
      score,
      sessionId: record.sessionId,
    };

    if (score >= this.config.goodScoreThreshold) {
      this.state.pendingGood.push(entry);
    } else if (score <= this.config.badScoreThreshold) {
      this.state.pendingBad.push(entry);
    } else {
      // Mid-range scores: skip for GRPO (need clear good/bad contrast)
      return false;
    }

    // Try to form pairs from pending buffers
    this.formPairs();
    this.saveState();

    // Auto-trigger training when enough pairs are ready
    if (this.state.grpoPairs.length >= this.config.minSamplesForTraining && !this.isTraining) {
      await this.runTraining();
      return true;
    }

    return false;
  }

  /**
   * Scan session directories and extract GRPO pairs from historical data.
   * Useful for bootstrapping from existing session logs.
   */
  async collectFromSessions(): Promise<number> {
    let pairsFound = 0;

    for (const sessionDir of this.config.sessionPaths) {
      if (!existsSync(sessionDir)) continue;

      const files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
      for (const file of files) {
        const filePath = join(sessionDir, file);
        try {
          const pairs = this.extractPairsFromSession(filePath);
          this.state.grpoPairs.push(...pairs);
          pairsFound += pairs.length;
        } catch {
          // Skip malformed session files
        }
      }
    }

    this.state.totalPairsCollected += pairsFound;
    this.saveState();
    return pairsFound;
  }

  // ── Training ─────────────────────────────────────────────────────

  /**
   * Execute a local LoRA training run using the Python script.
   * Writes GRPO pairs to JSONL, spawns the trainer, validates, and hot-swaps.
   */
  async runTraining(): Promise<CheckpointInfo> {
    if (this.isTraining) {
      throw new Error("Training already in progress");
    }
    if (this.state.grpoPairs.length === 0) {
      throw new Error("No GRPO pairs available for training");
    }

    this.isTraining = true;
    const checkpointId = `ckpt_local_${Date.now()}`;
    const outputDir = join(this.config.checkpointDir, checkpointId);

    const checkpoint: CheckpointInfo = {
      id: checkpointId,
      model: this.config.ollamaModel,
      loraRank: this.config.loraRank,
      trainingSamples: this.state.grpoPairs.length,
      avgTrainingScore:
        Math.round(
          (this.state.grpoPairs.reduce((s, p) => s + p.chosen_score, 0) /
            this.state.grpoPairs.length) *
            100
        ) / 100,
      benchmarkScore: null,
      status: "training",
      createdAt: new Date().toISOString(),
      promotedAt: null,
    };

    this.state.checkpoints.push(checkpoint);

    // Write GRPO pairs to JSONL for the Python script
    const dataPath = join(this.config.dataDir, `${checkpointId}.jsonl`);
    const jsonl = this.state.grpoPairs.map((p) => JSON.stringify(p)).join("\n") + "\n";
    writeFileSync(dataPath, jsonl);

    // Clear consumed pairs
    const consumedCount = this.state.grpoPairs.length;
    this.state.grpoPairs = [];
    this.state.totalRuns += 1;
    this.saveState();

    try {
      // Run the Python training script
      console.log(`[local-trainer] Starting training: ${consumedCount} pairs, rank=${this.config.loraRank}`);
      await this.spawnTrainer(dataPath, outputDir);
      checkpoint.status = "validating";
      this.saveState();

      // Validate the checkpoint
      console.log(`[local-trainer] Validating checkpoint ${checkpointId}`);
      const benchScore = await this.validateCheckpoint(checkpointId);
      checkpoint.benchmarkScore = benchScore;

      if (benchScore >= this.config.promotionThreshold) {
        // Hot-swap into Ollama
        console.log(`[local-trainer] Promoting checkpoint (score: ${benchScore})`);
        await this.hotSwapOllama(outputDir, checkpointId);
        checkpoint.status = "promoted";
        checkpoint.promotedAt = new Date().toISOString();
        this.state.activeCheckpointId = checkpointId;
      } else {
        console.log(`[local-trainer] Checkpoint below threshold (${benchScore} < ${this.config.promotionThreshold}), rolling back`);
        checkpoint.status = "rolled_back";
      }
    } catch (err) {
      console.error(`[local-trainer] Training failed:`, err);
      checkpoint.status = "rolled_back";
      checkpoint.benchmarkScore = 0;
    } finally {
      this.isTraining = false;
      this.saveState();
    }

    return checkpoint;
  }

  // ── Ollama Hot-Swap ──────────────────────────────────────────────

  /**
   * Create an Ollama model with the LoRA adapter via `ollama create`.
   * Generates a Modelfile pointing to the base model + adapter.
   */
  private async hotSwapOllama(adapterDir: string, checkpointId: string): Promise<void> {
    const modelName = `${this.config.ollamaModel}-lora-${checkpointId}`;
    const modelfilePath = join(adapterDir, "Modelfile");

    // Write Modelfile for Ollama
    const modelfile = [
      `FROM ${this.config.ollamaModel}`,
      `ADAPTER ${adapterDir}`,
      `PARAMETER temperature 0.7`,
      `PARAMETER top_p 0.9`,
      `SYSTEM "You are an expert coding assistant fine-tuned for autonomous agent tasks."`,
    ].join("\n");
    writeFileSync(modelfilePath, modelfile);

    // Create the model in Ollama
    const proc = spawn({
      cmd: ["ollama", "create", modelName, "-f", modelfilePath],
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`ollama create failed (exit ${exitCode}): ${stderr.slice(0, 500)}`);
    }

    console.log(`[local-trainer] Ollama model created: ${modelName}`);

    // Write a symlink/reference so the agent knows the active model name
    const activePath = join(this.config.checkpointDir, "active_model.txt");
    writeFileSync(activePath, modelName);
  }

  /**
   * Get the currently active fine-tuned model name for Ollama.
   * Returns null if no checkpoint has been promoted.
   */
  getActiveOllamaModel(): string | null {
    const activePath = join(this.config.checkpointDir, "active_model.txt");
    if (!existsSync(activePath)) return null;
    try {
      return readFileSync(activePath, "utf-8").trim();
    } catch {
      return null;
    }
  }

  // ── Status ───────────────────────────────────────────────────────

  getStatus(): {
    isTraining: boolean;
    pendingGood: number;
    pendingBad: number;
    grpoPairsReady: number;
    minForTraining: number;
    totalPairs: number;
    totalRuns: number;
    checkpoints: CheckpointInfo[];
    activeCheckpoint: string | null;
    activeOllamaModel: string | null;
  } {
    return {
      isTraining: this.isTraining,
      pendingGood: this.state.pendingGood.length,
      pendingBad: this.state.pendingBad.length,
      grpoPairsReady: this.state.grpoPairs.length,
      minForTraining: this.config.minSamplesForTraining,
      totalPairs: this.state.totalPairsCollected,
      totalRuns: this.state.totalRuns,
      checkpoints: this.state.checkpoints.slice(-10),
      activeCheckpoint: this.state.activeCheckpointId,
      activeOllamaModel: this.getActiveOllamaModel(),
    };
  }

  // ── Private Helpers ──────────────────────────────────────────────

  /**
   * Match pending good/bad responses into GRPO pairs.
   * Uses prompt similarity — for now, pairs by insertion order
   * (assumes roughly alternating quality across sessions).
   */
  private formPairs(): void {
    while (this.state.pendingGood.length > 0 && this.state.pendingBad.length > 0) {
      const good = this.state.pendingGood.shift()!;
      const bad = this.state.pendingBad.shift()!;

      // Use the good response's prompt as the canonical prompt
      // (both respond to similar agent tasks)
      this.state.grpoPairs.push({
        prompt: good.prompt,
        chosen: good.response,
        rejected: bad.response,
        chosen_score: good.score,
        rejected_score: bad.score,
        session_id: good.sessionId,
        collected_at: new Date().toISOString(),
      });
      this.state.totalPairsCollected += 1;
    }
  }

  /**
   * Extract preference pairs from a session JSONL file.
   * Looks for user messages followed by assistant responses,
   * then uses heuristic scoring based on tool success rate.
   */
  private extractPairsFromSession(filePath: string): GrpoPair[] {
    const lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
    const turns: SessionTurn[] = lines.map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter(Boolean) as SessionTurn[];

    const pairs: GrpoPair[] = [];
    const responses: Array<{
      prompt: string;
      response: string;
      score: number;
    }> = [];

    let currentPrompt = "";
    let currentResponse = "";
    let toolSuccesses = 0;
    let toolTotal = 0;

    for (const turn of turns) {
      if (turn.type === "user_message" && turn.message?.content) {
        // Save previous response if we have one
        if (currentPrompt && currentResponse) {
          const score = toolTotal > 0 ? toolSuccesses / toolTotal : 0.5;
          responses.push({ prompt: currentPrompt, response: currentResponse, score });
        }
        currentPrompt = turn.message.content;
        currentResponse = "";
        toolSuccesses = 0;
        toolTotal = 0;
      } else if (turn.type === "assistant_message" && turn.message?.content) {
        currentResponse += turn.message.content;
      } else if (turn.type === "tool_result") {
        toolTotal += 1;
        // Heuristic: results without "error" or "Error" are successes
        const result = (turn as unknown as { result: string }).result ?? "";
        if (typeof result === "string" && !result.toLowerCase().includes("error")) {
          toolSuccesses += 1;
        }
      }
    }

    // Save last response
    if (currentPrompt && currentResponse) {
      const score = toolTotal > 0 ? toolSuccesses / toolTotal : 0.5;
      responses.push({ prompt: currentPrompt, response: currentResponse, score });
    }

    // Form pairs: sort by score, pair highest with lowest
    responses.sort((a, b) => b.score - a.score);
    const half = Math.floor(responses.length / 2);
    for (let i = 0; i < half; i++) {
      const good = responses[i];
      const bad = responses[responses.length - 1 - i];
      if (good.score > bad.score && good.score >= 0.6 && bad.score <= 0.4) {
        pairs.push({
          prompt: good.prompt,
          chosen: good.response,
          rejected: bad.response,
          chosen_score: good.score,
          rejected_score: bad.score,
          session_id: filePath,
          collected_at: new Date().toISOString(),
        });
      }
    }

    return pairs;
  }

  /**
   * Spawn the Python training script via Bun.
   */
  private async spawnTrainer(dataPath: string, outputDir: string): Promise<void> {
    const args = [
      "python3",
      this.config.trainerScript,
      "--data", dataPath,
      "--base-model", this.config.baseModelHf,
      "--output", outputDir,
      "--epochs", String(this.config.epochs),
      "--lora-rank", String(this.config.loraRank),
      "--lr", String(this.config.learningRate),
      "--batch-size", String(this.config.batchSize),
      "--backend", this.config.backend,
    ];

    console.log(`[local-trainer] Spawning: ${args.join(" ")}`);

    const proc = spawn({
      cmd: args,
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...process.env,
        // Ensure MPS is used
        PYTORCH_MPS_HIGH_WATERMARK_RATIO: "0.0",
        TOKENIZERS_PARALLELISM: "false",
      },
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`Python trainer exited with code ${exitCode}`);
    }

    // Verify the adapter was actually created
    const adapterConfig = join(outputDir, "adapter_config.json");
    if (!existsSync(adapterConfig)) {
      throw new Error(`Training completed but no adapter found at ${outputDir}`);
    }

    console.log(`[local-trainer] Training complete, adapter at ${outputDir}`);
  }

  /**
   * Validate a checkpoint against the benchmark suite.
   */
  private async validateCheckpoint(checkpointId: string): Promise<number> {
    const ollamaModel = this.getActiveOllamaModel();
    const cmdParts = this.config.validateCommand.split(" ");

    const proc = spawn({
      cmd: cmdParts,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        CHECKPOINT_ID: checkpointId,
        CHECKPOINT_MODEL: ollamaModel ?? this.config.ollamaModel,
      },
    });

    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    // Try reading structured results
    try {
      const resultsPath = join(this.config.checkpointDir, checkpointId, "benchmark_results.json");
      if (existsSync(resultsPath)) {
        const results = JSON.parse(readFileSync(resultsPath, "utf-8"));
        return results.avgScore ?? 0;
      }
    } catch {}

    // Fallback: parse from stdout
    const match = stdout.match(/(?:Avg Score|score|Score):\s*([\d.]+)/i);
    return match ? parseFloat(match[1]) : 0;
  }

  private loadState(): LocalTrainerState {
    const statePath = join(this.config.dataDir, "local-trainer-state.json");
    try {
      if (existsSync(statePath)) {
        return JSON.parse(readFileSync(statePath, "utf-8"));
      }
    } catch {}
    return {
      pendingGood: [],
      pendingBad: [],
      grpoPairs: [],
      checkpoints: [],
      activeCheckpointId: null,
      totalPairsCollected: 0,
      totalRuns: 0,
      updatedAt: "",
    };
  }

  private saveState(): void {
    const statePath = join(this.config.dataDir, "local-trainer-state.json");
    this.state.updatedAt = new Date().toISOString();
    writeFileSync(statePath, JSON.stringify(this.state, null, 2));
  }

  private ensureDirs(): void {
    for (const dir of [this.config.dataDir, this.config.checkpointDir]) {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
  }
}

// ── Dependency checker ───────────────────────────────────────────────

/**
 * Check if the Python training environment is ready.
 * Returns a diagnostic report.
 */
export async function checkTrainerDeps(): Promise<{
  ready: boolean;
  python: boolean;
  torch: boolean;
  mps: boolean;
  peft: boolean;
  unsloth: boolean;
  transformers: boolean;
  systemRam: string;
  issues: string[];
}> {
  const issues: string[] = [];
  const result = {
    ready: false,
    python: false,
    torch: false,
    mps: false,
    peft: false,
    unsloth: false,
    transformers: false,
    systemRam: "unknown",
    issues,
  };

  // Check Python
  try {
    const proc = spawn({ cmd: ["python3", "--version"], stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    result.python = code === 0;
    if (!result.python) issues.push("python3 not found");
  } catch {
    issues.push("python3 not found");
  }

  if (!result.python) return result;

  // Check all deps in one Python call
  const checkScript = `
import json, sys
info = {}
try:
    import torch
    info["torch"] = True
    info["mps"] = torch.backends.mps.is_available()
except ImportError:
    info["torch"] = False
    info["mps"] = False

try:
    import peft
    info["peft"] = True
except ImportError:
    info["peft"] = False

try:
    import unsloth
    info["unsloth"] = True
except ImportError:
    info["unsloth"] = False

try:
    import transformers
    info["transformers"] = True
except ImportError:
    info["transformers"] = False

try:
    import subprocess
    r = subprocess.run(["sysctl", "hw.memsize"], capture_output=True, text=True)
    info["ram_gb"] = int(r.stdout.split()[-1]) / 1e9
except:
    info["ram_gb"] = 0

print(json.dumps(info))
`;

  try {
    const proc = spawn({
      cmd: ["python3", "-c", checkScript],
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code === 0) {
      const stdout = await new Response(proc.stdout).text();
      const info = JSON.parse(stdout.trim());
      result.torch = info.torch ?? false;
      result.mps = info.mps ?? false;
      result.peft = info.peft ?? false;
      result.unsloth = info.unsloth ?? false;
      result.transformers = info.transformers ?? false;
      result.systemRam = info.ram_gb ? `${Math.round(info.ram_gb)}GB` : "unknown";
    }
  } catch {}

  if (!result.torch) issues.push("PyTorch not installed: pip install torch");
  if (!result.mps) issues.push("MPS (Apple GPU) not available — training will be slow on CPU");
  if (!result.peft && !result.unsloth) {
    issues.push("Neither peft nor unsloth installed: pip install peft");
  }
  if (!result.transformers) issues.push("transformers not installed: pip install transformers");

  result.ready = result.torch && result.transformers && (result.peft || result.unsloth);
  return result;
}
