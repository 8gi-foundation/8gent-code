/**
 * Trigger detection tests per spec §4.
 *
 * Covers all four trigger sources individually and verifies that:
 *   - first occurrences of a candidate event do NOT fire (they arm)
 *   - the second occurrence fires the trigger
 *   - non-matching intervening events disarm
 *   - cooldown after exit prevents tight re-engagement
 *   - DoomLoopDetector subscription is duck-typed and survives a detector
 *     that has not yet shipped the EventEmitter mixin (RFC #2527 Option A)
 */

import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import type { DoomLoopDetector } from "../../eight/tool-loop-detector.js";
import {
	ClickWithoutChangeDetector,
	EngagementLoop,
	type EngagementLoopHooks,
	FindZeroHitsTwiceDetector,
	type SessionWorkers,
	WaitForTimeoutDetector,
} from "../engagement-loop.js";

function noopHooks(): EngagementLoopHooks {
	return {
		spawnSession: async (): Promise<SessionWorkers> => ({
			teardown: async () => {},
		}),
	};
}

describe("FindZeroHitsTwiceDetector", () => {
	it("does not fire on a single zero-hit", () => {
		const d = new FindZeroHitsTwiceDetector();
		expect(d.record("q1", 0)).toBe(false);
	});

	it("fires on the second consecutive zero-hit for the same query", () => {
		const d = new FindZeroHitsTwiceDetector();
		expect(d.record("q1", 0)).toBe(false);
		expect(d.record("q1", 0)).toBe(true);
	});

	it("does not fire when the second zero is for a different query", () => {
		const d = new FindZeroHitsTwiceDetector();
		expect(d.record("q1", 0)).toBe(false);
		expect(d.record("q2", 0)).toBe(false);
	});

	it("disarms on a non-zero hit", () => {
		const d = new FindZeroHitsTwiceDetector();
		expect(d.record("q1", 0)).toBe(false);
		expect(d.record("q1", 3)).toBe(false);
		expect(d.record("q1", 0)).toBe(false);
		expect(d.record("q1", 0)).toBe(true);
	});

	it("does not re-fire on a third consecutive zero without explicit reset", () => {
		const d = new FindZeroHitsTwiceDetector();
		d.record("q1", 0);
		expect(d.record("q1", 0)).toBe(true);
		// The fire latches and clears; a third zero re-arms but does not fire.
		expect(d.record("q1", 0)).toBe(false);
	});
});

describe("WaitForTimeoutDetector", () => {
	it("returns null on success", () => {
		const d = new WaitForTimeoutDetector();
		expect(d.record(false)).toBeNull();
	});

	it("returns a wait_for_timeout trigger on timeout", () => {
		const d = new WaitForTimeoutDetector();
		const out = d.record(true);
		expect(out?.reason).toBe("wait_for_timeout");
	});
});

describe("ClickWithoutChangeDetector", () => {
	it("returns null while no click is pending", () => {
		const d = new ClickWithoutChangeDetector();
		expect(d.observe(null)).toBeNull();
	});

	it("clears on a material change inside the window", () => {
		let now = 1000;
		const d = new ClickWithoutChangeDetector(1500, 0.95, () => now);
		d.recordClick("k1");
		now = 1100;
		const out = d.observe({
			at: now,
			frame: { id: "f", path: "", width: 1, height: 1, displayId: 1, capturedAt: 0, scale: 1, platform: "darwin" } as unknown as never,
			diff: { similarity: 0.5, regions: [], pixelsDifferent: 100 },
		});
		expect(out).toBeNull();
		// After a material change, no further trigger fires even past the window.
		now = 5000;
		expect(d.observe(null)).toBeNull();
	});

	it("fires once the window elapses with no material change", () => {
		let now = 1000;
		const d = new ClickWithoutChangeDetector(1500, 0.95, () => now);
		d.recordClick("k1");
		now = 1200;
		expect(d.observe(null)).toBeNull();
		now = 2600;
		const out = d.observe(null);
		expect(out?.reason).toBe("click_no_observable_change");
	});

	it("treats sub-threshold similarity as non-material on byte-equality v0", () => {
		// On byte-equality v0 diff, similarity is either 1.0 (equal) or 0.0
		// (different). The threshold 0.95 means similarity 0.95+ is non-material;
		// a 0.96 observation while pending is treated as "no change" and the
		// trigger eventually fires when the window elapses. Documents the
		// graceful-degradation contract from spec §4 row 3.
		let now = 1000;
		const d = new ClickWithoutChangeDetector(1500, 0.95, () => now);
		d.recordClick("k1");
		now = 1100;
		const intermediate = d.observe({
			at: now,
			frame: {} as unknown as never,
			diff: { similarity: 0.96, regions: [], pixelsDifferent: 0 },
		});
		expect(intermediate).toBeNull();
		now = 2600;
		const out = d.observe(null);
		expect(out?.reason).toBe("click_no_observable_change");
	});
});

describe("EngagementLoop trigger arming", () => {
	it("fires from armFindResult when the find detector fires", async () => {
		const loop = new EngagementLoop({ hooks: noopHooks(), defaultTtlSteps: 4 });
		const events: string[] = [];
		loop.on("trigger:fired", () => events.push("trigger"));
		loop.on("session:opened", () => events.push("opened"));
		await loop.armFindResult("qK", 0);
		await loop.armFindResult("qK", 0);
		expect(events).toEqual(["trigger", "opened"]);
		expect(loop.current()?.reason).toBe("find_zero_hits_repeated");
		await loop.dispose();
	});

	it("fires from armWaitForResult on timeout", async () => {
		const loop = new EngagementLoop({ hooks: noopHooks() });
		await loop.armWaitForResult(true);
		expect(loop.current()?.reason).toBe("wait_for_timeout");
		await loop.dispose();
	});

	it("respects post-exit cooldown for the same trigger source", async () => {
		const loop = new EngagementLoop({
			hooks: noopHooks(),
			defaultTtlSteps: 1,
			postExitCooldownMs: 10_000,
		});
		await loop.armWaitForResult(true);
		await loop.exitExplicit();
		const fired: boolean[] = [];
		loop.on("trigger:fired", (p) => fired.push(p.cooldownActive));
		// Same reason fires the trigger, but cooldown blocks engagement.
		await loop.armWaitForResult(true);
		expect(fired).toEqual([true]);
		expect(loop.current()).toBeNull();
		await loop.dispose();
	});

	it("only opens one session even when multiple triggers fire", async () => {
		const loop = new EngagementLoop({ hooks: noopHooks() });
		const opened: number[] = [];
		loop.on("session:opened", () => opened.push(1));
		await loop.armWaitForResult(true);
		await loop.armWaitForResult(true);
		await loop.armFindResult("qK", 0);
		await loop.armFindResult("qK", 0);
		expect(opened.length).toBe(1);
		await loop.dispose();
	});
});

describe("DoomLoopDetector subscription", () => {
	it("subscribes via duck-typed .on('stuck', ...) when the detector is an EventEmitter", async () => {
		// Construct a fake DoomLoopDetector that already has the
		// EventEmitter mixin shipped in RFC #2527 Option A.
		class FakeDoomDetector extends EventEmitter {}
		const detector = new FakeDoomDetector();

		const loop = new EngagementLoop({
			hooks: noopHooks(),
			doomDetector: detector as unknown as DoomLoopDetector,
		});

		expect(loop.current()).toBeNull();

		// Emit the live contract per packages/eight/tool-loop-detector.ts
		// (DoomStuckEvent shape locked in PR #2534 / RFC #2527 Option A).
		detector.emit("stuck", {
			period: 2,
			reps: 2,
			windowSize: 12,
			detectedAt: Date.now(),
			signatures: ["eyes_find:{}", "desktop_click:{}"],
		});

		// The listener fires synchronously off the event emit; await a
		// microtask so the loop's async fire() resolves.
		await Promise.resolve();
		await Promise.resolve();
		expect(loop.current()?.reason).toBe("doom_loop_detected");
		await loop.dispose();
	});

	it("survives a detector without the EventEmitter mixin (graceful degradation)", async () => {
		const bareDetector = { check: () => false };
		const loop = new EngagementLoop({
			hooks: noopHooks(),
			doomDetector: bareDetector as unknown as DoomLoopDetector,
		});
		// No throw on construction. Other triggers still fire normally.
		await loop.armWaitForResult(true);
		expect(loop.current()?.reason).toBe("wait_for_timeout");
		await loop.dispose();
	});
});
