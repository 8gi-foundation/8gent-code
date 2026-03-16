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

export interface KernelConfig {
  /** Enable the kernel fine-tuning pipeline (default: false) */
  enabled: boolean;
  /** Path to metaclaw.yaml (default: config/metaclaw.yaml) */
  configPath: string;
  /** Override production config */
  production: Partial<ProductionConfig>;
}

const DEFAULT_KERNEL_CONFIG: KernelConfig = {
  enabled: false,
  configPath: "config/metaclaw.yaml",
  production: {},
};

export class KernelManager {
  private config: KernelConfig;
  private loop: ProductionLoop | null = null;

  constructor(config: Partial<KernelConfig> = {}) {
    this.config = { ...DEFAULT_KERNEL_CONFIG, ...config };
  }

  /**
   * Initialize from .8gent/config.json metaclaw section.
   */
  static fromProjectConfig(projectRoot: string = process.cwd()): KernelManager {
    const configPath = resolve(projectRoot, ".8gent/config.json");
    if (!existsSync(configPath)) {
      return new KernelManager();
    }

    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      const mc = config.metaclaw ?? {};
      return new KernelManager({
        enabled: mc.enabled ?? false,
        configPath: mc.configPath ?? "config/metaclaw.yaml",
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
