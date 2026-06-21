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

import { join } from "node:path";
import {
	getExperienceSummary,
	getModelOrder,
	recordResult,
} from "../../benchmarks/autoresearch/model-router";
import { type JudgeConfig, JudgeScorer, type ScoreRecord } from "./judge";
import { adaptPairsFile } from "./pair-adapter";
import {
	type BumpClass,
	type CanarySignal,
	evaluatePromotion,
	type HoldOut,
	type HumanConfirm,
	loadPromotionPolicy,
} from "./promotion-gate";
import { type ProxyConfig, type ProxyStatus, TrainingProxy } from "./proxy";
import { type CheckpointInfo, type TrainingConfig, TrainingOrchestrator } from "./training";

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
	/**
	 * Auto-promote improved checkpoints to model-router. DEFAULT FALSE (P0-2).
	 * Historically this defaulted true and swapped the active model on a single
	 * cloud-judge verdict with no frozen hold-out, no canary, and a no-op
	 * rollback. It now defaults FALSE: a checkpoint is held PENDING and is only
	 * promoted through the promotion gate (frozen hold-out beat + canary + human
	 * confirm). Autonomy is Level 0 - human confirm on every promotion.
	 */
	autoPromote: boolean;
	/** Optional thermal gate: training only proceeds when this returns true.
	 * MadMax sleep/idle is ANDed with thermal nominal so the overnight run never
	 * cooks the laptop. Defaults to always-nominal when not provided. */
	thermalNominal?: () => boolean;
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
	// P0-2: default FALSE. Promotion now requires the promotion gate
	// (frozen hold-out + canary + human confirm), never a single judge verdict.
	autoPromote: false,
	scoreTrendAlertThreshold: 0.5,
	fineTunedModelTag: "",
};

export class ProductionLoop {
	private config: ProductionConfig;
	private proxy: TrainingProxy;
	private judge: JudgeScorer;
	private trainer: TrainingOrchestrator;
	private lastActivityAt: number = Date.now();
	private startedAt = 0;
	private running = false;
	private tickInterval: ReturnType<typeof setInterval> | null = null;

	constructor(config: Partial<ProductionConfig> = {}) {
		this.config = { ...DEFAULT_PRODUCTION_CONFIG, ...config };

		// Default fine-tuned model tag
		if (!this.config.fineTunedModelTag) {
			const base = this.config.training.baseModel ?? "qwen3:14b";
			this.config.fineTunedModelTag = `${base.replace(/:.*/, "")}-ft`;
		}

		this.proxy = new TrainingProxy({
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
		response: string,
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
	getHealthStatus(): {
		healthy: boolean;
		trend: "improving" | "stable" | "declining";
		message: string;
	} {
		const trend = this.judge.getScoreTrend(7);
		if (trend.length < 2) {
			return {
				healthy: true,
				trend: "stable",
				message: "Insufficient data for trend analysis",
			};
		}

		const recent = trend.slice(-3);
		const older = trend.slice(0, -3);
		const recentAvg = recent.reduce((s, t) => s + t.avg, 0) / recent.length;
		const olderAvg =
			older.length > 0 ? older.reduce((s, t) => s + t.avg, 0) / older.length : recentAvg;

		const delta = recentAvg - olderAvg;

		if (delta > 0.05) {
			return {
				healthy: true,
				trend: "improving",
				message: `Scores improving (+${(delta * 100).toFixed(1)}%)`,
			};
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
		// A trained checkpoint is PENDING, never auto-promoted. Promotion is a
		// separate, gated action (frozen hold-out + canary + human confirm). When
		// autoPromote is false (default) we never touch the router here.
		this.maybePromote(checkpoint);
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

		// Connector 3 (ISI wiring): collect -> adapt -> train. Before training,
		// convert the collected single-response pairs (plus any hedge-derived
		// multi-candidate contrast) into the GRPO chosen/rejected file the LoRA
		// trainer reads. This is the step that was missing - the loop previously
		// trained from the buffer directly and never routed through the adapter.
		// adaptPairsFile is a pure file transform; with no multi-candidate data it
		// simply writes zero pairs (no fabricated preference), so it is safe to run
		// unconditionally on every training tick.
		try {
			const trainingDir = ".8gent/kernel/training";
			adaptPairsFile(join(trainingDir, "pairs.jsonl"), join(trainingDir, "grpo.jsonl"), {
				hedgeSignalPath: join(trainingDir, "hedge-signal.jsonl"),
			});
		} catch (err) {
			console.error(`[kernel] Pair adaptation failed (continuing): ${err}`);
		}

		// All conditions met — trigger training
		try {
			const checkpoint = await this.trainer.train();
			this.maybePromote(checkpoint);
		} catch (err) {
			console.error(`[kernel] Training tick failed: ${err}`);
		}
	}

	/**
	 * Promotion is GATED. A freshly trained checkpoint is PENDING; it is only
	 * promoted when autoPromote is explicitly enabled AND the promotion gate
	 * passes (frozen hold-out + canary + human confirm). With autoPromote false
	 * (the default), this is a no-op: the candidate is held, never swapped.
	 *
	 * The full gate (canary signal + human-confirm token) is supplied by the
	 * surface that owns those signals (TUI/daemon). This loop deliberately does
	 * NOT fabricate a human confirm or a canary, so it can never self-promote.
	 */
	private maybePromote(checkpoint: CheckpointInfo): void {
		if (!this.config.autoPromote) return; // default path: nothing promotes
		// Even when autoPromote is on, this loop has no human-confirm token and no
		// canary signal of its own, so it does not call promoteCheckpoint here.
		// Promotion is driven explicitly by the gated surface. We only surface the
		// pending candidate; we never swap the router autonomously.
		if (checkpoint.status === "pending") {
			console.log(
				`[kernel] Checkpoint ${checkpoint.id} is PENDING promotion (awaiting hold-out + canary + human confirm).`,
			);
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
		// In BOTH cases, the overnight LoRA run is additionally gated on thermal
		// nominal so it never cooks the laptop (ResourceGovernor seam).
		const thermalOk = this.config.thermalNominal ? this.config.thermalNominal() : true;
		const scheduleAllowed = this.config.madmaxEnabled ? inSleepWindow || isIdle : true;
		const trainingAllowed = scheduleAllowed && thermalOk;

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
	 * Promote a PENDING checkpoint through the full promotion gate. This is the
	 * ONLY path that can swap the active model into the router. It is called by
	 * the gated surface (TUI/daemon) that owns the canary signal and the human
	 * confirm token - never by the autonomous training tick.
	 *
	 * All of the following must hold or the swap is refused:
	 *   - autoPromote enabled in policy
	 *   - candidate beat-or-tied the FROZEN hold-out
	 *   - canary healthy
	 *   - human confirm present for minor+ (and patch at autonomy 0)
	 *
	 * On success, the trainer writes a rollback manifest before the swap and the
	 * router experience DB is updated.
	 */
	promoteThroughGate(
		checkpointId: string,
		args: {
			bump: BumpClass;
			holdOut: HoldOut;
			canary: CanarySignal;
			humanConfirm?: HumanConfirm;
		},
	): { promoted: boolean; reason: string } {
		const policy = loadPromotionPolicy();
		const checkpoint = this.trainer.getCheckpoints().find((c) => c.id === checkpointId);
		if (!checkpoint) return { promoted: false, reason: "checkpoint not found" };

		const decision = evaluatePromotion(
			{
				candidateId: checkpointId,
				bump: args.bump,
				holdOut: args.holdOut,
				holdOutResult: { tasks: checkpoint.holdOutScores ?? {} },
				canary: args.canary,
				humanConfirm: args.humanConfirm,
			},
			policy,
		);
		if (!decision.promote) return { promoted: false, reason: decision.reason };

		const swap = this.trainer.promoteCheckpoint(checkpointId, {
			holdOut: args.holdOut,
			gateApproved: true,
			candidateVersion: checkpointId,
		});
		if (!swap.promoted) return swap;

		// Router experience DB update is the final, gated step.
		const promoted = this.trainer.getActiveCheckpoint();
		if (promoted) this.promoteToRouter(promoted);
		return { promoted: true, reason: decision.reason };
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
			checkpoint.benchmarkScore,
		);
	}
}
