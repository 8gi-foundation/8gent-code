/**
 * KernelManager — Unified entry point for the fine-tuning pipeline.
 *
 * Reads config, initializes all phases, and provides a simple API
 * for the agent loop to hook into.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { ProductionLoop, type ProductionConfig, type LoopStatus } from "./loop";
import type { ScoreRecord } from "./judge";
import type { CheckpointInfo } from "./training";
import { PersonalCollector, type TrainingPair, type CollectorStats } from "./personal-collector";

export interface KernelConfig {
  /** Enable the kernel fine-tuning pipeline (default: false) */
  enabled: boolean;
  /** Path to training-proxy.yaml (default: config/training-proxy.yaml) */
  configPath: string;
  /**
   * Path to the user's Personal LoRA adapter (Layer 3).
   * This is where the user's local fine-tune lives, trained on their own
   * coding patterns via the kernel pipeline. Retrained when Eight LoRA
   * (Layer 2) updates to stay aligned with the new base adapter weights.
   */
  personalLoraPath: string;
  /** Override production config */
  production: Partial<ProductionConfig>;
}

const DEFAULT_KERNEL_CONFIG: KernelConfig = {
  enabled: false,
  configPath: "config/training-proxy.yaml",
  personalLoraPath: "~/.8gent/personal-lora/",
  production: {},
};

export class KernelManager {
  private config: KernelConfig;
  private loop: ProductionLoop | null = null;
  private userId: string | null = null;
  private collector: PersonalCollector;

  constructor(config: Partial<KernelConfig> = {}) {
    this.config = { ...DEFAULT_KERNEL_CONFIG, ...config };
    this.collector = new PersonalCollector();
  }

  /**
   * Initialize from .8gent/config.json training_proxy section.
   */
  static fromProjectConfig(projectRoot: string = process.cwd()): KernelManager {
    const configPath = resolve(projectRoot, ".8gent/config.json");
    if (!existsSync(configPath)) {
      return new KernelManager();
    }

    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      const mc = config.training_proxy ?? {};
      return new KernelManager({
        enabled: mc.enabled ?? false,
        configPath: mc.configPath ?? "config/training-proxy.yaml",
        production: {
          proxy: { port: 30000, ollamaUrl: "http://localhost:11434" },
          training: { baseModel: mc.baseModel ?? "qwen3:14b" },
        },
      });
    } catch {
      return new KernelManager();
    }
  }

  /**
   * Start the kernel pipeline if enabled.
   */
  async start(): Promise<boolean> {
    if (!this.config.enabled) return false;

    this.loop = new ProductionLoop(this.config.production);
    try {
      await this.loop.start();
      return true;
    } catch (err) {
      console.error(`[kernel] Failed to start: ${err}`);
      this.loop = null;
      return false;
    }
  }

  /**
   * Stop the kernel pipeline.
   */
  async stop(): Promise<void> {
    if (this.loop) {
      await this.loop.stop();
      this.loop = null;
    }
  }

  /**
   * Process an agent turn through the scoring and training pipeline.
   * Safe to call even when disabled — returns null.
   */
  async processTurn(
    sessionId: string,
    turnIndex: number,
    model: string,
    prompt: string,
    response: string
  ): Promise<ScoreRecord | null> {
    if (!this.loop) return null;
    return this.loop.processTurn(sessionId, turnIndex, model, prompt, response);
  }

  /**
   * Record user activity (resets idle timer for MadMax scheduling).
   */
  recordActivity(): void {
    this.loop?.recordActivity();
  }

  /**
   * Get the model to use — fine-tuned if promoted, base otherwise.
   */
  getActiveModel(): string | null {
    if (!this.loop) return null;
    return this.loop.getActiveModel();
  }

  /**
   * Get full pipeline status.
   */
  async getStatus(): Promise<LoopStatus | null> {
    if (!this.loop) return null;
    return this.loop.getStatus();
  }

  /**
   * Get health status (score trend direction).
   */
  getHealth(): { healthy: boolean; trend: string; message: string } | null {
    if (!this.loop) return null;
    return this.loop.getHealthStatus();
  }

  /**
   * Force a training run regardless of schedule.
   */
  async forceTraining(): Promise<CheckpointInfo | null> {
    if (!this.loop) return null;
    return this.loop.forceTraining();
  }

  /**
   * Set user ID for personal LoRA training.
   */
  setUserId(userId: string): void {
    this.userId = userId;
  }

  /**
   * Collect a session trace for personal LoRA training.
   * Pairs are quality-filtered before storage.
   */
  collectSessionTrace(
    sessionId: string,
    prompt: string,
    response: string,
    score: number,
    options?: { model?: string; toolCallsSucceeded?: boolean; userCorrected?: boolean }
  ): boolean {
    if (!this.userId) return false;

    return this.collector.collect({
      userId: this.userId,
      sessionId,
      prompt,
      response,
      score,
      model: options?.model || "unknown",
      toolCallsSucceeded: options?.toolCallsSucceeded ?? true,
      userCorrected: options?.userCorrected ?? false,
    });
  }

  /**
   * Get training collection stats.
   */
  getCollectorStats(): CollectorStats {
    return this.collector.getStats();
  }

  /**
   * Get collected pair count for the current user.
   */
  getTrainingPairCount(): number {
    return this.collector.getPairCount(this.userId || undefined);
  }

  /**
   * Whether the kernel is currently active.
   */
  get isActive(): boolean {
    return this.loop !== null;
  }

  /**
   * Whether kernel is enabled in config.
   */
  get isEnabled(): boolean {
    return this.config.enabled;
  }
}
