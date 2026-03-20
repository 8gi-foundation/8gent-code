/**
 * Phase 3: RL Training Orchestration
 *
 * Manages GRPO training lifecycle:
 * - Collect training batches from scored responses
 * - Trigger training when batch is full
 * - Validate checkpoints against benchmark suite
 * - Rollback on regression, promote on improvement
 */

import { spawn } from "bun";
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { ScoreRecord } from "./judge";

export interface TrainingConfig {
  /** Base model being fine-tuned */
  baseModel: string;
  /** LoRA rank (default: 32) */
  loraRank: number;
  /** Batch size for GRPO update (default: 4) */
  batchSize: number;
  /** Min average score to include in training (default: 0.3) */
  minScoreThreshold: number;
  /** Max average score — skip "easy" examples (default: 0.95) */
  maxScoreThreshold: number;
  /** Directory for training data and checkpoints */
  dataDir: string;
  /** Benchmark validation command */
  validateCommand: string;
  /** Min benchmark score to promote checkpoint (default: 80) */
  promotionThreshold: number;
  /** Training proxy config path */
  trainingProxyConfigPath: string;
}

export interface CheckpointInfo {
  id: string;
  model: string;
  loraRank: number;
  trainingSamples: number;
  avgTrainingScore: number;
  benchmarkScore: number | null;
  status: "training" | "validating" | "promoted" | "rolled_back" | "pending";
  createdAt: string;
  promotedAt: string | null;
}

interface TrainingBatch {
  samples: TrainingSample[];
  batchId: string;
  createdAt: string;
}

interface TrainingSample {
  prompt: string;
  response: string;
  score: number;
  model: string;
  sessionId: string;
}

interface TrainingState {
  currentBatch: TrainingSample[];
  checkpoints: CheckpointInfo[];
  totalSamplesCollected: number;
  totalTrainingRuns: number;
  activeCheckpointId: string | null;
  baselineScores: Record<string, number>;
  updatedAt: string;
}

const DEFAULT_TRAINING_CONFIG: TrainingConfig = {
  baseModel: "qwen3:14b",
  loraRank: 32,
  batchSize: 4,
  minScoreThreshold: 0.3,
  maxScoreThreshold: 0.95,
  dataDir: ".8gent/kernel/training",
  validateCommand: "bun run benchmarks/autoresearch/validate-checkpoint.ts",
  promotionThreshold: 80,
  trainingProxyConfigPath: "config/training-proxy.yaml",
};

export class TrainingOrchestrator {
  private config: TrainingConfig;
  private state: TrainingState;
  private isTraining = false;

  constructor(config: Partial<TrainingConfig> = {}) {
    this.config = { ...DEFAULT_TRAINING_CONFIG, ...config };
    this.state = this.loadState();
    this.ensureDirs();
  }

  /**
   * Add a scored response to the training buffer.
   * Returns true if a training run was triggered.
   */
  async addSample(record: ScoreRecord): Promise<boolean> {
    const score = record.scores.overall;

    // Filter: only train on mid-range scores (not trivial, not perfect)
    if (score < this.config.minScoreThreshold || score > this.config.maxScoreThreshold) {
      return false;
    }

    this.state.currentBatch.push({
      prompt: record.prompt,
      response: record.response,
      score,
      model: record.model,
      sessionId: record.sessionId,
    });
    this.state.totalSamplesCollected += 1;
    this.saveState();

    // Trigger training when batch is full
    if (this.state.currentBatch.length >= this.config.batchSize && !this.isTraining) {
      await this.train();
      return true;
    }

    return false;
  }

  /**
   * Manually trigger a training run with current batch.
   */
  async train(): Promise<CheckpointInfo> {
    if (this.isTraining) {
      throw new Error("Training already in progress");
    }
    if (this.state.currentBatch.length === 0) {
      throw new Error("No training samples in buffer");
    }

    this.isTraining = true;
    const batchId = `batch_${Date.now()}`;
    const checkpointId = `ckpt_${Date.now()}`;

    const checkpoint: CheckpointInfo = {
      id: checkpointId,
      model: this.config.baseModel,
      loraRank: this.config.loraRank,
      trainingSamples: this.state.currentBatch.length,
      avgTrainingScore:
        Math.round(
          (this.state.currentBatch.reduce((s, x) => s + x.score, 0) /
            this.state.currentBatch.length) *
            100
        ) / 100,
      benchmarkScore: null,
      status: "training",
      createdAt: new Date().toISOString(),
      promotedAt: null,
    };

    this.state.checkpoints.push(checkpoint);

    // Write training batch to disk for the training proxy
    const batch: TrainingBatch = {
      samples: [...this.state.currentBatch],
      batchId,
      createdAt: new Date().toISOString(),
    };
    const batchPath = join(this.config.dataDir, "batches", `${batchId}.json`);
    writeFileSync(batchPath, JSON.stringify(batch, null, 2));

    // Clear the buffer
    this.state.currentBatch = [];
    this.state.totalTrainingRuns += 1;
    this.saveState();

    try {
      // Trigger proxy training
      await this.triggerProxyTraining(batchPath);
      checkpoint.status = "validating";
      this.saveState();

      // Validate the checkpoint
      const benchScore = await this.validateCheckpoint(checkpointId);
      checkpoint.benchmarkScore = benchScore;

      if (benchScore >= this.config.promotionThreshold) {
        checkpoint.status = "promoted";
        checkpoint.promotedAt = new Date().toISOString();
        this.state.activeCheckpointId = checkpointId;
      } else {
        checkpoint.status = "rolled_back";
        await this.rollback(checkpointId);
      }
    } catch (err) {
      checkpoint.status = "rolled_back";
      checkpoint.benchmarkScore = 0;
    } finally {
      this.isTraining = false;
      this.saveState();
    }

    return checkpoint;
  }

  /**
   * Get the current training state.
   */
  getState(): {
    bufferSize: number;
    batchSize: number;
    totalSamples: number;
    totalRuns: number;
    checkpoints: CheckpointInfo[];
    activeCheckpoint: string | null;
    isTraining: boolean;
  } {
    return {
      bufferSize: this.state.currentBatch.length,
      batchSize: this.config.batchSize,
      totalSamples: this.state.totalSamplesCollected,
      totalRuns: this.state.totalTrainingRuns,
      checkpoints: this.state.checkpoints.slice(-10),
      activeCheckpoint: this.state.activeCheckpointId,
      isTraining: this.isTraining,
    };
  }

  /**
   * Get all checkpoints with their status.
   */
  getCheckpoints(): CheckpointInfo[] {
    return [...this.state.checkpoints];
  }

  /**
   * Get the active (promoted) checkpoint.
   */
  getActiveCheckpoint(): CheckpointInfo | null {
    if (!this.state.activeCheckpointId) return null;
    return this.state.checkpoints.find((c) => c.id === this.state.activeCheckpointId) ?? null;
  }

  /**
   * Save baseline scores for regression comparison.
   */
  setBaseline(scores: Record<string, number>): void {
    this.state.baselineScores = scores;
    this.saveState();
  }

  // ── Private helpers ────────────────────────────────────────────────

  private async triggerProxyTraining(batchPath: string): Promise<void> {
    const proc = spawn({
      cmd: [
        "metaclaw", "train",
        "--batch", batchPath,
        "--model", this.config.baseModel,
        "--lora-rank", String(this.config.loraRank),
      ],
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`Training proxy failed (exit ${exitCode}): ${stderr.slice(0, 500)}`);
    }
  }

  private async validateCheckpoint(_checkpointId: string): Promise<number> {
    const proc = spawn({
      cmd: this.config.validateCommand.split(" "),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        TRAINING_PROXY_URL: "http://localhost:30000",
      },
    });

    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    // Parse the validation result
    try {
      const resultsPath = join(
        dirname(this.config.validateCommand.split(" ").pop()!),
        "checkpoint-results.json"
      );
      if (existsSync(resultsPath)) {
        const results = JSON.parse(readFileSync(resultsPath, "utf-8"));
        return results.avgScore ?? 0;
      }
    } catch {}

    // Fallback: parse score from stdout
    const scoreMatch = stdout.match(/Avg Score:\s+([\d.]+)/);
    return scoreMatch ? parseFloat(scoreMatch[1]) : 0;
  }

  private async rollback(_checkpointId: string): Promise<void> {
    // Tell the training proxy to revert to previous weights
    try {
      const proc = spawn({
        cmd: ["metaclaw", "rollback"],
        stdout: "pipe",
        stderr: "pipe",
      });
      await proc.exited;
    } catch {
      // Best effort — the training proxy may handle rollback internally
    }
  }

  private loadState(): TrainingState {
    const statePath = join(this.config.dataDir, "state.json");
    try {
      if (existsSync(statePath)) {
        return JSON.parse(readFileSync(statePath, "utf-8"));
      }
    } catch {}
    return {
      currentBatch: [],
      checkpoints: [],
      totalSamplesCollected: 0,
      totalTrainingRuns: 0,
      activeCheckpointId: null,
      baselineScores: {},
      updatedAt: "",
    };
  }

  private saveState(): void {
    const statePath = join(this.config.dataDir, "state.json");
    this.state.updatedAt = new Date().toISOString();
    writeFileSync(statePath, JSON.stringify(this.state, null, 2));
  }

  private ensureDirs(): void {
    for (const sub of ["batches", "checkpoints"]) {
      const dir = join(this.config.dataDir, sub);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
  }
}
