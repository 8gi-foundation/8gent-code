/**
 * Contract tests for `formatSessionTime`. The TUI bottom-HUD SESSION
 * card depends on this exact behaviour (#2367) - if any of these
 * assertions break, the HUD will silently regress to "749m 59"-style
 * output that brought the issue in.
 */

import { describe, expect, test } from "bun:test";
import { formatSessionTime, hudTokens, msUntilSessionTimeChanges } from "./format.js";

describe("formatSessionTime", () => {
	test("under 60s reports whole seconds", () => {
		expect(formatSessionTime(0)).toBe("0s");
		expect(formatSessionTime(999)).toBe("0s");
		expect(formatSessionTime(1_000)).toBe("1s");
		expect(formatSessionTime(59_000)).toBe("59s");
	});

	test("under 60m reports whole minutes, no seconds", () => {
		expect(formatSessionTime(60_000)).toBe("1m");
		expect(formatSessionTime(62_500)).toBe("1m");
		expect(formatSessionTime(59 * 60_000 + 30_000)).toBe("59m");
	});

	test("under 24h reports hours + minutes", () => {
		expect(formatSessionTime(60 * 60_000)).toBe("1h 0m");
		expect(formatSessionTime(60 * 60_000 + 30 * 60_000)).toBe("1h 30m");
		// Spec example: previously rendered as "749m 59"; should be 12h 29m.
		expect(formatSessionTime(749 * 60_000 + 59_000)).toBe("12h 29m");
		expect(formatSessionTime(23 * 3_600_000 + 59 * 60_000)).toBe("23h 59m");
	});

	test("at and beyond 24h reports days + hours", () => {
		expect(formatSessionTime(24 * 3_600_000)).toBe("1d 0h");
		expect(formatSessionTime(25 * 3_600_000)).toBe("1d 1h");
		expect(formatSessionTime(72 * 3_600_000 + 60 * 60_000)).toBe("3d 1h");
	});

	test("non-finite or negative input clamps to 0s", () => {
		expect(formatSessionTime(-100)).toBe("0s");
		expect(formatSessionTime(Number.NaN)).toBe("0s");
	});
});

describe("msUntilSessionTimeChanges", () => {
	test("first minute: sleeps to the next whole second", () => {
		expect(msUntilSessionTimeChanges(0)).toBe(1_000);
		expect(msUntilSessionTimeChanges(1_250)).toBe(750);
		expect(msUntilSessionTimeChanges(59_999)).toBe(1);
	});

	test("after the first minute: sleeps to the next whole minute", () => {
		expect(msUntilSessionTimeChanges(60_000)).toBe(60_000);
		expect(msUntilSessionTimeChanges(62_500)).toBe(57_500);
		expect(msUntilSessionTimeChanges(5 * 3_600_000 + 30_000)).toBe(30_000);
	});

	test("after a day: sleeps to the next whole hour", () => {
		expect(msUntilSessionTimeChanges(24 * 3_600_000)).toBe(3_600_000);
		expect(msUntilSessionTimeChanges(24 * 3_600_000 + 60_000)).toBe(3_540_000);
	});

	test("the text really does change at the wake-up and not before it", () => {
		for (const at of [0, 1_250, 59_999, 60_000, 62_500, 3_599_000, 3_600_000, 86_399_000, 86_400_000, 90_000_000]) {
			const wait = msUntilSessionTimeChanges(at);
			expect(formatSessionTime(at + wait - 1)).toBe(formatSessionTime(at));
			expect(formatSessionTime(at + wait)).not.toBe(formatSessionTime(at));
		}
	});

	test("non-finite or negative input behaves like 0", () => {
		expect(msUntilSessionTimeChanges(-5)).toBe(1_000);
		expect(msUntilSessionTimeChanges(Number.NaN)).toBe(1_000);
	});
});

describe("hudTokens (audit 2026-09-30, #7)", () => {
	test("zero, or no count yet, is empty: no '0 tok' before the first reply", () => {
		expect(hudTokens(0)).toBe("");
		expect(hudTokens(-3)).toBe("");
		expect(hudTokens(Number.NaN)).toBe("");
	});

	test("above zero it reads as before", () => {
		expect(hudTokens(842)).toBe("842 tok");
		expect(hudTokens(6400)).toBe("6.4K tok");
		expect(hudTokens(179_000)).toBe("179K tok");
	});
});
