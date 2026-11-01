/**
 * Loop Guard Tests
 *
 * Tests for the loop stop condition system.
 *
 * Run: bun test packages/daemon/loop-guard.test.ts
 */

import { describe, expect, it, beforeEach } from "bun:test";
import {
	LoopGuard,
	LoopGuardStore,
	STOP_REASON,
	createQuickGuard,
	createThoroughGuard,
	createSafeGuard,
	DEFAULT_LOOP_GUARD_CONFIG,
} from "./loop-guard";

describe("LoopGuard", () => {
	let guard: LoopGuard;

	beforeEach(() => {
		guard = new LoopGuard();
	});

	it("starts in running state", () => {
		const result = guard.check();
		expect(result.shouldStop).toBe(false);
	});

	it("records iterations", () => {
		guard.recordIteration(0.1);
		guard.recordIteration(0.2);
		expect(guard.getState().iterationCount).toBe(2);
	});

	it("stops after max iterations", () => {
		const quickGuard = createQuickGuard();
		for (let i = 0; i < 10; i++) {
			quickGuard.recordIteration(i * 0.1);
		}

		const result = quickGuard.check();
		expect(result.shouldStop).toBe(true);
		expect(result.reason).toBe(STOP_REASON.MAX_ITERATIONS);
	});

	it("stops after max errors", () => {
		guard.recordError("error 1");
		guard.recordError("error 2");
		guard.recordError("error 3");

		const result = guard.check();
		expect(result.shouldStop).toBe(true);
		expect(result.reason).toBe(STOP_REASON.ERROR_THRESHOLD);
	});

	it("pauses and resumes", () => {
		guard.pause();
		expect(guard.check().shouldStop).toBe(true);

		guard.resume();
		expect(guard.check().shouldStop).toBe(false);
	});

	it("marks escalation pending", () => {
		guard.markEscalationPending();
		const result = guard.check();
		expect(result.shouldStop).toBe(true);
		expect(result.reason).toBe(STOP_REASON.ESCALATION_REQUIRED);
	});

	it("detects no progress (deadlock)", () => {
		const quickGuard = createQuickGuard();
		// Record iterations without progress
		for (let i = 0; i < 7; i++) {
			quickGuard.recordIteration(0.5); // Same progress each time
		}

		const result = quickGuard.check();
		expect(result.shouldStop).toBe(true);
		expect(result.reason).toBe(STOP_REASON.DEADLOCK);
	});

	it("resets properly", () => {
		guard.recordIteration(0.5);
		guard.recordError("test");
		guard.reset();

		const state = guard.getState();
		expect(state.iterationCount).toBe(0);
		expect(state.errorCount).toBe(0);
	});

	it("reports remaining iterations", () => {
		guard.recordIteration(0.1);
		guard.recordIteration(0.2);
		expect(guard.remainingIterations()).toBe(98);
	});

	it("requires escalation for risky actions", () => {
		expect(guard.requiresEscalation("risky")).toBe(true);
		expect(guard.requiresEscalation("safe")).toBe(false);
	});
});

describe("LoopGuardStore", () => {
	let store: LoopGuardStore;

	beforeEach(() => {
		store = new LoopGuardStore();
	});

	it("creates and retrieves guards", () => {
		const guard = store.create("loop-1");
		expect(store.get("loop-1")).toBe(guard);
	});

	it("stops loops", () => {
		store.create("loop-1");
		const stopped = store.stop("loop-1", STOP_REASON.GOAL_ACHIEVED);

		expect(stopped).toBe(true);
		const loop = store.list()[0];
		expect(loop.status).toBe("stopped");
		expect(loop.stopReason).toBe(STOP_REASON.GOAL_ACHIEVED);
	});

	it("pauses and resumes loops", () => {
		store.create("loop-1");
		store.pause("loop-1");
		let loop = store.list()[0];
		expect(loop.status).toBe("paused");

		store.resume("loop-1");
		loop = store.list()[0];
		expect(loop.status).toBe("running");
	});

	it("removes loops", () => {
		store.create("loop-1");
		store.remove("loop-1");
		expect(store.get("loop-1")).toBeUndefined();
	});

	it("clears all loops", () => {
		store.create("loop-1");
		store.create("loop-2");
		store.clear();
		expect(store.list()).toHaveLength(0);
	});
});

describe("Guard Factories", () => {
	it("createQuickGuard has tight limits", () => {
		const guard = createQuickGuard();
		const state = guard.getState();
		expect(state.config.maxIterations).toBe(10);
		expect(state.config.maxDurationMs).toBe(60000);
	});

	it("createThoroughGuard has generous limits", () => {
		const guard = createThoroughGuard();
		const state = guard.getState();
		expect(state.config.maxIterations).toBe(200);
		expect(state.config.maxDurationMs).toBe(3600000);
	});

	it("createSafeGuard is conservative", () => {
		const guard = createSafeGuard();
		const state = guard.getState();
		expect(state.config.maxErrors).toBe(1);
		expect(state.config.maxIterations).toBe(50);
	});
});

describe("Progress Tracking", () => {
	it("detects positive progress", () => {
		const guard = new LoopGuard();
		guard.recordIteration(0.1);
		guard.recordIteration(0.2);
		guard.recordIteration(0.3);

		// Need enough iterations for progress check
		guard.recordIteration(0.4);
		guard.recordIteration(0.5);

		const result = guard.check();
		expect(result.shouldStop).toBe(false);
	});

	it("detects regression", () => {
		const guard = new LoopGuard();
		guard.recordIteration(0.8);
		guard.recordIteration(0.6);
		guard.recordIteration(0.4);

		// More iterations with regression
		guard.recordIteration(0.2);
		guard.recordIteration(0.1);

		// Add one more iteration so iterationCount (6) > PROGRESS_WINDOW (5)
		guard.recordIteration(0.05);

		// Regression should eventually trigger deadlock after PROGRESS_WINDOW
		const result = guard.check();
		expect(result.shouldStop).toBe(true);
	});
});