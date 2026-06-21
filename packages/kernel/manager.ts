/**
 * KernelManager — Unified entry point for the fine-tuning pipeline.
 *
 * Reads config, initializes all phases, and provides a simple API
 * for the agent loop to hook into.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_HEDGE_CONFIG, HedgeExecutor, type HedgeConfig } from "./hedge-executor";
import type { ScoreRecord } from "./judge";
import { type LoopStatus, type ProductionConfig, ProductionLoop } from "./loop";
import { type CollectorStats, PersonalCollector, type TrainingPair } from "./personal-collector";
import type { CheckpointInfo } from "./training";

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
	/**
	 * Hedge executor config. Default OFF. The hedge executor is independent of
	 * the training pipeline `enabled` flag - it can accumulate dormant preference
	 * data with training fully off - but it is OFF by default and only fires K
	 * candidates when `hedge.enabled` is true.
	 */
	hedge: Partial<HedgeConfig>;
}

const DEFAULT_KERNEL_CONFIG: KernelConfig = {
	enabled: false,
	configPath: "config/training-proxy.yaml",
	personalLoraPath: "~/.8gent/personal-lora/",
	production: {},
	hedge: { enabled: false },
};

export class KernelManager {
	private config: KernelConfig;
	private loop: ProductionLoop | null = null;
	private userId: string | null = null;
	private collector: PersonalCollector;
	private hedgeExecutor: HedgeExecutor;

	constructor(config: Partial<KernelConfig> = {}) {
		this.config = { ...DEFAULT_KERNEL_CONFIG, ...config };
		this.collector = new PersonalCollector();
		this.hedgeExecutor = new HedgeExecutor({ ...DEFAULT_HEDGE_CONFIG, ...this.config.hedge });
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
				// Hedge stays OFF unless training_proxy.hedge.enabled is explicitly true.
				hedge: { enabled: mc.hedge?.enabled === true, ...(mc.hedge ?? {}) },
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
		response: string,
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
		options?: {
			model?: string;
			toolCallsSucceeded?: boolean;
			userCorrected?: boolean;
		},
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

	/**
	 * The hedge executor. Default OFF: when its flag is off, `run()` fires exactly
	 * one candidate and is byte-identical to a single generate call. The agent
	 * loop wraps its single `agent.generate` call with this so that, when hedging
	 * is enabled, winner-vs-loser preference data accumulates dormantly on disk.
	 */
	get hedge(): HedgeExecutor {
		return this.hedgeExecutor;
	}

	/**
	 * Whether the hedge executor is enabled. Default false.
	 */
	get isHedgeEnabled(): boolean {
		return this.hedgeExecutor.enabled;
	}
}
