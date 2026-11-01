/**
 * Loop Guard - Stop Conditions for Agent Loops
 *
 * Prevents infinite loops by defining clear termination conditions.
 * Integrates with the autonomy ladder for escalation decisions.
 */

import { AUTONOMY_RUNG, type AutonomyRung, type ActionRisk } from "./autonomy";

// ============================================
// Stop Condition Types
// ============================================

export const STOP_REASON = {
	TIMEOUT: "timeout",
	MAX_ITERATIONS: "max_iterations",
	GOAL_ACHIEVED: "goal_achieved",
	USER_INTERRUPT: "user_interrupt",
	ERROR_THRESHOLD: "error_threshold",
	ESCALATION_REQUIRED: "escalation_required",
	DEADLOCK: "deadlock",
	RISK_THRESHOLD: "risk_threshold",
} as const;

export type StopReason =
	(typeof STOP_REASON)[keyof typeof STOP_REASON];

export interface LoopState {
	iterationCount: number;
	startTime: number;
	lastActivityTime: number;
	errorCount: number;
	lastError: string | null;
	pendingEscalation: boolean;
	isPaused: boolean;
}

// ============================================
// Configuration
// ============================================

export interface LoopGuardConfig {
	/** Maximum iterations before stopping (default: 100) */
	maxIterations: number;
	/** Maximum time in ms before stopping (default: 30 min) */
	maxDurationMs: number;
	/** Maximum consecutive errors (default: 3) */
	maxErrors: number;
	/** Maximum idle time in ms (no progress) (default: 5 min) */
	maxIdleMs: number;
	/** Minimum autonomy rung required to self-escalate */
	escalationRung: AutonomyRung;
	/** Risk level that requires escalation */
	escalationRisk: ActionRisk;
}

export const DEFAULT_LOOP_GUARD_CONFIG: LoopGuardConfig = {
	maxIterations: 100,
	maxDurationMs: 30 * 60 * 1000, // 30 minutes
	maxErrors: 3,
	maxIdleMs: 5 * 60 * 1000, // 5 minutes
	escalationRung: AUTONOMY_RUNG.DELEGATE,
	escalationRisk: "risky",
};

// ============================================
// Loop Guard
// ============================================

export interface StopConditionResult {
	shouldStop: boolean;
	reason: StopReason | null;
	details: string;
}

export interface ProgressResult {
	hasProgress: boolean;
	progressDelta: number; // 0-1 indicating improvement
}

export class LoopGuard {
	private config: LoopGuardConfig;
	private state: LoopState;
	private progressHistory: number[] = [];
	private readonly PROGRESS_WINDOW = 5; // Check against last N iterations

	constructor(config: Partial<LoopGuardConfig> = {}) {
		this.config = { ...DEFAULT_LOOP_GUARD_CONFIG, ...config };
		this.state = this.createInitialState();
	}

	private createInitialState(): LoopState {
		const now = Date.now();
		return {
			iterationCount: 0,
			startTime: now,
			lastActivityTime: now,
			errorCount: 0,
			lastError: null,
			pendingEscalation: false,
			isPaused: false,
		};
	}

	/** Reset the guard for a new loop */
	reset(): void {
		this.state = this.createInitialState();
		this.progressHistory = [];
	}

	/** Record an iteration */
	recordIteration(progress = 0): void {
		this.state.iterationCount++;
		this.state.lastActivityTime = Date.now();
		this.progressHistory.push(progress);

		// Keep only the last N progress values
		if (this.progressHistory.length > this.PROGRESS_WINDOW) {
			this.progressHistory.shift();
		}
	}

	/** Record an error */
	recordError(error: string): void {
		this.state.errorCount++;
		this.state.lastError = error;
		this.state.lastActivityTime = Date.now();
	}

	/** Mark that escalation has been requested */
	markEscalationPending(): void {
		this.state.pendingEscalation = true;
	}

	/** Pause the loop */
	pause(): void {
		this.state.isPaused = true;
	}

	/** Resume the loop */
	resume(): void {
		this.state.isPaused = false;
	}

	/** Check if loop should stop */
	check(): StopConditionResult {
		// Always stop if paused
		if (this.state.isPaused) {
			return {
				shouldStop: true,
				reason: STOP_REASON.USER_INTERRUPT,
				details: "Loop is paused",
			};
		}

		// Check max iterations
		if (this.state.iterationCount >= this.config.maxIterations) {
			return {
				shouldStop: true,
				reason: STOP_REASON.MAX_ITERATIONS,
				details: `Reached max iterations: ${this.state.iterationCount}`,
			};
		}

		// Check timeout
		const elapsed = Date.now() - this.state.startTime;
		if (elapsed >= this.config.maxDurationMs) {
			return {
				shouldStop: true,
				reason: STOP_REASON.TIMEOUT,
				details: `Duration exceeded: ${elapsed}ms`,
			};
		}

		// Check error threshold
		if (this.state.errorCount >= this.config.maxErrors) {
			return {
				shouldStop: true,
				reason: STOP_REASON.ERROR_THRESHOLD,
				details: `Error count exceeded: ${this.state.errorCount}`,
			};
		}

		// Check idle timeout
		const idle = Date.now() - this.state.lastActivityTime;
		if (idle >= this.config.maxIdleMs && this.state.iterationCount > 0) {
			return {
				shouldStop: true,
				reason: STOP_REASON.TIMEOUT,
				details: `Idle timeout: ${idle}ms without activity`,
			};
		}

		// Check for deadlock (no progress in window)
		if (this.state.iterationCount >= this.PROGRESS_WINDOW) {
			const progressResult = this.checkProgress();
			if (!progressResult.hasProgress && this.state.iterationCount > this.PROGRESS_WINDOW) {
				return {
					shouldStop: true,
					reason: STOP_REASON.DEADLOCK,
					details: `No progress detected in last ${this.PROGRESS_WINDOW} iterations`,
				};
			}
		}

		// Check escalation pending
		if (this.state.pendingEscalation) {
			return {
				shouldStop: true,
				reason: STOP_REASON.ESCALATION_REQUIRED,
				details: "Escalation requested, waiting for approval",
			};
		}

		return {
			shouldStop: false,
			reason: null,
			details: "Loop continues",
		};
	}

	/** Check if there's been progress */
	private checkProgress(): ProgressResult {
		if (this.progressHistory.length < 2) {
			return { hasProgress: true, progressDelta: 0 };
		}

		const oldest = this.progressHistory[0];
		const newest = this.progressHistory[this.progressHistory.length - 1];
		const delta = newest - oldest;

		return {
			hasProgress: delta > 0.01, // 1% threshold
			progressDelta: delta,
		};
	}

	/** Get remaining iterations */
	remainingIterations(): number {
		return Math.max(0, this.config.maxIterations - this.state.iterationCount);
	}

	/** Get remaining time in ms */
	remainingTimeMs(): number {
		const elapsed = Date.now() - this.state.startTime;
		return Math.max(0, this.config.maxDurationMs - elapsed);
	}

	/** Get current state (for debugging/UI) */
	getState(): LoopState & { config: LoopGuardConfig } {
		return {
			...this.state,
			config: this.config,
		};
	}

	/** Check if action risk requires escalation */
	requiresEscalation(risk: ActionRisk): boolean {
		const riskOrder: ActionRisk[] = ["safe", "bounded", "risky", "destructive"];
		const actionRiskIndex = riskOrder.indexOf(risk);
		const thresholdRiskIndex = riskOrder.indexOf(this.config.escalationRisk);
		return actionRiskIndex >= thresholdRiskIndex;
	}
}

// ============================================
// Loop Guard Store (for managing multiple loops)
// ============================================

export interface ManagedLoop {
	id: string;
	guard: LoopGuard;
	config: LoopGuardConfig;
	status: "running" | "stopped" | "paused";
	stopReason: StopReason | null;
}

export class LoopGuardStore {
	private loops = new Map<string, ManagedLoop>();

	create(id: string, config?: Partial<LoopGuardConfig>): LoopGuard {
		const fullConfig = { ...DEFAULT_LOOP_GUARD_CONFIG, ...config };
		const guard = new LoopGuard(fullConfig);

		this.loops.set(id, {
			id,
			guard,
			config: fullConfig,
			status: "running",
			stopReason: null,
		});

		return guard;
	}

	get(id: string): LoopGuard | undefined {
		return this.loops.get(id)?.guard;
	}

	stop(id: string, reason: StopReason): boolean {
		const loop = this.loops.get(id);
		if (!loop) return false;

		loop.status = "stopped";
		loop.stopReason = reason;
		return true;
	}

	pause(id: string): boolean {
		const loop = this.loops.get(id);
		if (!loop) return false;

		loop.guard.pause();
		loop.status = "paused";
		return true;
	}

	resume(id: string): boolean {
		const loop = this.loops.get(id);
		if (!loop) return false;

		loop.guard.resume();
		loop.status = "running";
		return true;
	}

	list(): ManagedLoop[] {
		return Array.from(this.loops.values());
	}

	remove(id: string): boolean {
		return this.loops.delete(id);
	}

	clear(): void {
		this.loops.clear();
	}
}

// ============================================
// Pre-configured guard factories
// ============================================

export function createQuickGuard(): LoopGuard {
	return new LoopGuard({
		maxIterations: 10,
		maxDurationMs: 60 * 1000, // 1 minute
		maxErrors: 2,
		maxIdleMs: 30 * 1000,
	});
}

export function createThoroughGuard(): LoopGuard {
	return new LoopGuard({
		maxIterations: 200,
		maxDurationMs: 60 * 60 * 1000, // 1 hour
		maxErrors: 5,
		maxIdleMs: 10 * 60 * 1000,
	});
}

export function createSafeGuard(): LoopGuard {
	return new LoopGuard({
		maxIterations: 50,
		maxDurationMs: 15 * 60 * 1000,
		maxErrors: 1,
		maxIdleMs: 60 * 1000,
	});
}