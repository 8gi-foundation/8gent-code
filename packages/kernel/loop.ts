/**
 * Phase 4: Production Loop
 *
 * The complete continuous improvement pipeline:
 * - MadMax scheduling (train during idle/sleep, never during active sessions)
 * - Regression gates via autoresearch benchmark suite
 * - Auto-promotion of improved checkpoints into model-router
 * - Score trend monitoring and alerting
 * - Graceful degradation when components are unavailable
 */

import { MetaClawProxy, type ProxyConfig, type ProxyStatus } from "./proxy";
import { JudgeScorer, type JudgeConfig, type ScoreRecord } from "./judge";
import { TrainingOrchestrator, type TrainingConfig, type CheckpointInfo } from "./training";
import { recordResult, getModelOrder, getExperienceSummary } from "../../benchmarks/autoresearch/model-router";

export interface ProductionConfig {
  proxy: Partial<ProxyConfig>;
  judge: Partial<JudgeConfig>;
  training: Partial<TrainingConfig>;
  /** Enable MadMax scheduling (default: true) */
  madmaxEnabled: boolean;
  /** Sleep window start hour (0-23, default: 23) */
  sleepStart: number;
  /** Sleep window end hour (0-23, default: 7) */
  sleepEnd: number;
  /** Idle threshold in minutes before allowing training (default: 30) */
  idleThresholdMinutes: number;
  /** Auto-promote improved checkpoints to model-router (default: true) */
  autoPromote: boolean;
  /** Score trend alert: warn if avg drops below this (default: 0.5) */
  scoreTrendAlertThreshold: number;
  /** Model tag for the fine-tuned variant (default: "{base}-ft") */
  fineTunedModelTag: string;
}

export interface LoopStatus {
  phase: "idle" | "collecting" | "scoring" | "training" | "validating" | "promoting";
  proxy: ProxyStatus | null;
  judgeAvailable: boolean;
  training: {
    bufferSize: number;
    batchSize: number;
    totalSamples: number;
    totalRuns: number;
    activeCheckpoint: string | null;
    isTraining: boolean;
  };
  schedule: {
    inSleepWindow: boolean;
    isIdle: boolean;
    trainingAllowed: boolean;
    lastActivity: string;
  };
  scoreTrend: Array<{ date: string; avg: number; count: number }>;
  uptime: number;
}

const DEFAULT_PRODUCTION_CONFIG: ProductionConfig = {
  proxy: {},
  judge: {},
  training: {},
  madmaxEnabled: true,
  sleepStart: 23,
  sleepEnd: 7,
  idleThresholdMinutes: 30,
  autoPromote: true,
  scoreTrendAlertThreshold: 0.5,
  fineTunedModelTag: "",
};

export class ProductionLoop {
  private config: ProductionConfig;
  private proxy: MetaClawProxy;
  private judge: JudgeScorer;
  private trainer: TrainingOrchestrator;
  private lastActivityAt: number = Date.now();
  private startedAt: number = 0;
  private running = false;
  private tickInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: Partial<ProductionConfig> = {}) {
    this.config = { ...DEFAULT_PRODUCTION_CONFIG, ...config };

    // Default fine-tuned model tag
    if (!this.config.fineTunedModelTag) {
      const base = this.config.training.baseModel ?? "qwen3:14b";
      this.config.fineTunedModelTag = `${base.replace(/:.*/, "")}-ft`;
    }

    this.proxy = new MetaClawProxy({
      ...this.config.proxy,
      mode: this.config.madmaxEnabled ? "madmax" : "rl",
    });
    this.judge = new JudgeScorer(this.config.judge);
    this.trainer = new TrainingOrchestrator(this.config.training);
  }

  /**
   * Start the production loop.
   * Phase 1: Start proxy
   * Phase 2: Verify judge
   * Phase 3+4: Begin collection and scheduled training
   */
  async start(): Promise<void> {
    if (this.running) return;

    // Phase 1: Start proxy
    await this.proxy.start();
    this.startedAt = Date.now();
    this.running = true;

    // Phase 2: Verify judge is reachable
    const judgeUp = await this.judge.isAvailable();
    if (!judgeUp) {
      console.warn("[kernel] Judge model not reachable — scoring disabled until available");
    }

    // Phase 4: Start the scheduling tick (check every 5 minutes)
    this.tickInterval = setInterval(() => this.tick(), 5 * 60 * 1000);
  }

  /**
   * Stop the production loop gracefully.
   */
  async stop(): Promise<void> {
    this.running = false;
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    await this.proxy.stop();
  }

  /**
   * Record activity (call this on user interaction to reset idle timer).
   */
  recordActivity(): void {
    this.lastActivityAt = Date.now();
  }

  /**
   * Process an agent turn — score it and feed to training pipeline.
   * Call this after each agent response in the main loop.
   */
  async processTurn(
    sessionId: string,
    turnIndex: number,
    model: string,
    prompt: string,
    response: string
  ): Promise<ScoreRecord | null> {
    this.recordActivity();

    // Score the response
    let record: ScoreRecord | null = null;
    try {
      record = await this.judge.score(sessionId, turnIndex, model, prompt, response);
    } catch {
      // Judge unavailable — skip scoring, don't block the session
      return null;
    }

    // Feed to training buffer
    await this.trainer.addSample(record);

    return record;
  }

  /**
   * Get the full loop status.
   */
  async getStatus(): Promise<LoopStatus> {
    const proxyStatus = this.running ? await this.proxy.getStatus() : null;
    const judgeAvailable = await this.judge.isAvailable();
    const trainingState = this.trainer.getState();
    const schedule = this.getScheduleState();
    const scoreTrend = this.judge.getScoreTrend(7);

    return {
      phase: this.getCurrentPhase(),
      proxy: proxyStatus,
      judgeAvailable,
      training: trainingState,
      schedule,
      scoreTrend,
      uptime: this.startedAt > 0 ? Date.now() - this.startedAt : 0,
    };
  }

  /**
   * Get which model should be used — fine-tuned if available, base otherwise.
   */
  getActiveModel(): string {
    const active = this.trainer.getActiveCheckpoint();
    if (active && active.status === "promoted") {
      return this.config.fineTunedModelTag;
    }
    return this.config.training.baseModel ?? "qwen3:14b";
  }

  /**
   * Check if the score trend indicates improvement or regression.
   */
  getHealthStatus(): { healthy: boolean; trend: "improving" | "stable" | "declining"; message: string } {
    const trend = this.judge.getScoreTrend(7);
    if (trend.length < 2) {
      return { healthy: true, trend: "stable", message: "Insufficient data for trend analysis" };
    }

    const recent = trend.slice(-3);
    const older = trend.slice(0, -3);
    const recentAvg = recent.reduce((s, t) => s + t.avg, 0) / recent.length;
    const olderAvg = older.length > 0
      ? older.reduce((s, t) => s + t.avg, 0) / older.length
      : recentAvg;

    const delta = recentAvg - olderAvg;

    if (delta > 0.05) {
      return { healthy: true, trend: "improving", message: `Scores improving (+${(delta * 100).toFixed(1)}%)` };
    }
    if (delta < -0.05) {
      const healthy = recentAvg >= this.config.scoreTrendAlertThreshold;
      return {
        healthy,
        trend: "declining",
        message: `Scores declining (${(delta * 100).toFixed(1)}%). ${healthy ? "Still above threshold." : "Below alert threshold!"}`,
      };
    }
    return { healthy: true, trend: "stable", message: "Scores stable" };
  }

  /**
   * Force a training run now, regardless of schedule.
   */
  async forceTraining(): Promise<CheckpointInfo> {
    const checkpoint = await this.trainer.train();

    if (checkpoint.status === "promoted" && this.config.autoPromote) {
      this.promoteToRouter(checkpoint);
    }

    return checkpoint;
  }

  // ── Private: Scheduling ────────────────────────────────────────────

  private async tick(): Promise<void> {
    if (!this.running) return;

    const schedule = this.getScheduleState();

    // Only train during allowed windows
    if (!schedule.trainingAllowed) return;

    const state = this.trainer.getState();
    if (state.bufferSize < state.batchSize) return;
    if (state.isTraining) return;

    // All conditions met — trigger training
    try {
      const checkpoint = await this.trainer.train();

      if (checkpoint.status === "promoted" && this.config.autoPromote) {
        this.promoteToRouter(checkpoint);
      }
    } catch (err) {
      console.error(`[kernel] Training tick failed: ${err}`);
    }
  }

  private getScheduleState(): {
    inSleepWindow: boolean;
    isIdle: boolean;
    trainingAllowed: boolean;
    lastActivity: string;
  } {
    const hour = new Date().getHours();
    const inSleepWindow =
      this.config.sleepStart > this.config.sleepEnd
        ? hour >= this.config.sleepStart || hour < this.config.sleepEnd
        : hour >= this.config.sleepStart && hour < this.config.sleepEnd;

    const idleMs = Date.now() - this.lastActivityAt;
    const isIdle = idleMs > this.config.idleThresholdMinutes * 60 * 1000;

    // MadMax: train only during sleep or idle
    // Non-MadMax: train anytime batch is ready
    const trainingAllowed = this.config.madmaxEnabled
      ? inSleepWindow || isIdle
      : true;

    return {
      inSleepWindow,
      isIdle,
      trainingAllowed,
      lastActivity: new Date(this.lastActivityAt).toISOString(),
    };
  }

  private getCurrentPhase(): LoopStatus["phase"] {
    if (!this.running) return "idle";
    const state = this.trainer.getState();
    if (state.isTraining) return "training";
    if (state.bufferSize > 0) return "collecting";
    return "idle";
  }

  /**
   * Promote a successful checkpoint into the model-router experience DB.
   * This makes the fine-tuned model the preferred choice for future routing.
   */
  private promoteToRouter(checkpoint: CheckpointInfo): void {
    if (checkpoint.benchmarkScore === null) return;

    // Record the fine-tuned model's benchmark performance in the experience router
    // This naturally makes it the top choice when model-router picks models
    recordResult(
      this.config.fineTunedModelTag,
      "kernel-finetuned",
      `ckpt-${checkpoint.id}`,
      checkpoint.benchmarkScore
    );
  }
}
