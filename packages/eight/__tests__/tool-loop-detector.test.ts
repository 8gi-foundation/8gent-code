/**
 * Tests for DoomLoopDetector cycle detection.
 *
 * Acceptance criteria from issue #2461:
 *  - check([A]) -> false
 *  - check([A,A,A]) -> true (period 1, reps 3)
 *  - check([A,B,A,B]) -> true (period 2, reps 2)
 *  - check([A,B,C,A,B,C]) -> true (period 3, reps 2)
 *  - check([A,B,C,D,A,B,C,D]) -> true (period 4, reps 2)
 *  - check returns false when fewer than period*reps calls
 *  - {a:1,b:2} vs {b:2,a:1} produce identical signatures
 *  - History truncates at 12 entries
 */

import { describe, expect, it } from "bun:test";
import { DoomLoopDetector, type DoomToolCall } from "../tool-loop-detector";

const call = (name: string, args: Record<string, unknown> = {}): DoomToolCall => ({
	toolName: name,
	args,
});

describe("DoomLoopDetector", () => {
	it("returns false for a single call", () => {
		const d = new DoomLoopDetector();
		expect(d.check([call("A")])).toBe(false);
	});

	it("detects period-1 loop (AAA, reps 3)", () => {
		const d = new DoomLoopDetector();
		expect(d.check([call("A"), call("A"), call("A")])).toBe(true);
	});

	it("does not fire period-1 with only two repeats", () => {
		const d = new DoomLoopDetector();
		expect(d.check([call("A"), call("A")])).toBe(false);
	});

	it("detects period-2 loop (ABAB, reps 2)", () => {
		const d = new DoomLoopDetector();
		expect(d.check([call("A"), call("B"), call("A"), call("B")])).toBe(true);
	});

	it("detects period-3 loop (ABCABC, reps 2)", () => {
		const d = new DoomLoopDetector();
		expect(
			d.check([call("A"), call("B"), call("C"), call("A"), call("B"), call("C")]),
		).toBe(true);
	});

	it("detects period-4 loop (ABCDABCD, reps 2)", () => {
		const d = new DoomLoopDetector();
		expect(
			d.check([
				call("A"),
				call("B"),
				call("C"),
				call("D"),
				call("A"),
				call("B"),
				call("C"),
				call("D"),
			]),
		).toBe(true);
	});

	it("returns false when fewer than period*reps calls present", () => {
		const d = new DoomLoopDetector();
		// period 2 needs 4 calls; only 3 here
		expect(d.check([call("A"), call("B"), call("A")])).toBe(false);
		// period 4 needs 8 calls; only 7 here
		const d2 = new DoomLoopDetector();
		expect(
			d2.check([
				call("A"),
				call("B"),
				call("C"),
				call("D"),
				call("A"),
				call("B"),
				call("C"),
			]),
		).toBe(false);
	});

	it("normalizes JSON args so key order does not matter", () => {
		const d = new DoomLoopDetector();
		const c1 = call("read", { a: 1, b: 2 });
		const c2 = call("read", { b: 2, a: 1 });
		const c3 = call("read", { a: 1, b: 2 });
		expect(d.check([c1, c2, c3])).toBe(true);
	});

	it("normalizes nested JSON args", () => {
		const d = new DoomLoopDetector();
		const c1 = call("write", { path: "/x", opts: { a: 1, b: 2 } });
		const c2 = call("write", { path: "/x", opts: { b: 2, a: 1 } });
		const c3 = call("write", { path: "/x", opts: { a: 1, b: 2 } });
		expect(d.check([c1, c2, c3])).toBe(true);
	});

	it("truncates history at 12 entries (older entries discarded)", () => {
		const d = new DoomLoopDetector();
		// Seed 12 distinct non-cyclic calls
		const seed = Array.from({ length: 12 }, (_, i) => call(`T${i}`));
		expect(d.check(seed)).toBe(false);
		// Now feed 3 of "X" -- if older entries were not discarded, the window
		// would still include the seed and might confuse detection. Period-1
		// detection on the trailing 3 should still fire because XXX is in the
		// last-3 of the 12-window after truncation.
		const trailing = [call("X"), call("X"), call("X")];
		expect(d.check(trailing)).toBe(true);
	});

	it("returns false for non-cyclic mixed calls", () => {
		const d = new DoomLoopDetector();
		expect(
			d.check([call("A"), call("B"), call("C"), call("D"), call("E")]),
		).toBe(false);
	});

	it("reset() clears history", () => {
		const d = new DoomLoopDetector();
		d.check([call("A"), call("A"), call("A")]);
		d.reset();
		expect(d.check([call("B")])).toBe(false);
	});

	it("treats same name with different args as distinct signatures", () => {
		const d = new DoomLoopDetector();
		const a1 = call("read", { path: "/a" });
		const a2 = call("read", { path: "/b" });
		// a1, a2, a1 is NOT a period-1 loop
		expect(d.check([a1, a2, a1])).toBe(false);
		// but a1, a2, a1, a2 IS period-2
		expect(d.check([a1, a2, a1, a2])).toBe(true);
	});
});
