/**
 * KernelManager — Unified entry point for the fine-tuning pipeline.
 *
 * Reads config, initializes all phases, and provides a simple API
 * for the agent loop to hook into.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_HEDGE_CONFIG, type HedgeConfig, HedgeExecutor } from "./hedge-executor";
import type { ScoreRecord } from "./judge";
import {
	type CollectResult,
	LessonCollector,
	type LessonExample,
	type LessonSources,
} from "./lesson-collector";
import { type LoopStatus, type ProductionConfig, ProductionLoop } from "./loop";
import { type CollectorStats, PersonalCollector, type TrainingPair } from "./personal-collector";
import { type ToolStep, TraceCapture, type Trajectory } from "./trace-capture";
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
	/**
	 * Capture tool-call trajectories from real sessions as training signal
	 * (#2752 step 1). Opt-in, default OFF, local-only, PII-scrubbed at
	 * capture. Like hedge, it is independent of the training `enabled` flag -
	 * trajectories can accumulate locally with training fully off.
	 */
	traceCapture: boolean;
	/**
	 * Feed the LiveDemo ledger + selfheal report findings into the kernel as
	 * labeled negative/positive examples (#2752 step 2). Opt-in, default OFF,
	 * local-only, PII-scrubbed at collection. Like hedge and traceCapture, it
	 * is independent of the training `enabled` flag.
	 */
	lessonFeeds: boolean;
	/** Override lesson source paths (tests; defaults live under ~/.8gent) */
	lessonSources: LessonSources;
	/** Project root for local kernel storage (default: process.cwd()) */
	projectRoot: string;
}

const DEFAULT_KERNEL_CONFIG: KernelConfig = {
	enabled: false,
	configPath: "config/training-proxy.yaml",
	personalLoraPath: "~/.8gent/personal-lora/",
	production: {},
	hedge: { enabled: false },
	traceCapture: false,
	lessonFeeds: false,
	lessonSources: {},
	projectRoot: process.cwd(),
};

export class KernelManager {
	private config: KernelConfig;
	private loop: ProductionLoop | null = null;
	private userId: string | null = null;
	private collector: PersonalCollector;
	private hedgeExecutor: HedgeExecutor;
	private tracer: TraceCapture;
	private lessonCollector: LessonCollector;

	constructor(config: Partial<KernelConfig> = {}) {
		this.config = { ...DEFAULT_KERNEL_CONFIG, ...config };
		this.collector = new PersonalCollector();
		this.hedgeExecutor = new HedgeExecutor({ ...DEFAULT_HEDGE_CONFIG, ...this.config.hedge });
		this.tracer = new TraceCapture(this.config.projectRoot, this.config.traceCapture);
		this.lessonCollector = new LessonCollector(
			this.config.projectRoot,
			this.config.lessonFeeds,
			this.config.lessonSources,
		);
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
				// Trace capture stays OFF unless explicitly opted in.
				traceCapture: mc.traceCapture === true,
				// Lesson feeds stay OFF unless explicitly opted in.
				lessonFeeds: mc.lessonFeeds === true,
				projectRoot,
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
	 * Buffer one tool step for the current turn's trajectory (#2752 step 1).
	 * No-op unless trace capture is opted in. Cheap enough for the tool loop.
	 */
	recordToolStep(step: ToolStep): void {
		this.tracer.recordToolStep(step);
	}

	/**
	 * Collect a session trace for personal LoRA training.
	 * Pairs are quality-filtered before storage.
	 *
	 * When trace capture is opted in, this also finalizes the turn's tool-call
	 * trajectory: scrubbed (secrets redacted, PII anonymized, dropped entirely
	 * if anything survives) and persisted to local JSONL. Runs before the
	 * userId gate because trajectories are session-scoped, not user-scoped.
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
			turnIndex?: number;
		},
	): boolean {
		const trajectory = this.tracer.finalizeTurn({
			sessionId,
			turnIndex: options?.turnIndex ?? 0,
			model: options?.model || "unknown",
			prompt,
			response,
			score,
		});

		if (!this.userId) return false;

		// A captured trajectory is ground truth for tool success: prefer its
		// per-step record over the caller's coarse flag.
		const toolCallsSucceeded =
			trajectory !== null && trajectory.toolSteps.length > 0
				? trajectory.allToolsSucceeded
				: (options?.toolCallsSucceeded ?? true);

		return this.collector.collect({
			userId: this.userId,
			sessionId,
			prompt,
			response,
			score,
			model: options?.model || "unknown",
			toolCallsSucceeded,
			userCorrected: options?.userCorrected ?? false,
		});
	}

	/**
	 * Read captured tool-call trajectories from local storage.
	 */
	getTrajectories(): Trajectory[] {
		return this.tracer.readTrajectories();
	}

	/**
	 * Feed the LiveDemo ledger + selfheal reports into local training storage
	 * as labeled negative/positive examples (#2752 step 2). No-op (all zeros)
	 * unless lesson feeds are opted in.
	 */
	collectLessons(): CollectResult {
		return this.lessonCollector.collect();
	}

	/**
	 * Read collected lesson examples from local storage.
	 */
	getLessons(): LessonExample[] {
		return this.lessonCollector.readLessons();
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

	/**
	 * Whether tool-call trajectory capture is opted in. Default false.
	 */
	get isTraceCaptureEnabled(): boolean {
		return this.tracer.enabled;
	}

	/**
	 * Whether lesson feeds (LiveDemo ledger + selfheal reports) are opted in.
	 * Default false.
	 */
	get isLessonFeedsEnabled(): boolean {
		return this.lessonCollector.enabled;
	}
}
