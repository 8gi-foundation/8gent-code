/**
 * Contract tests for `formatSessionTime`. The TUI bottom-HUD SESSION
 * card depends on this exact behaviour (#2367) - if any of these
 * assertions break, the HUD will silently regress to "749m 59"-style
 * output that brought the issue in.
 */

import { describe, expect, test } from "bun:test";
import { formatSessionTime } from "./format.js";

describe("formatSessionTime", () => {
	test("under 60s reports whole seconds", () => {
		expect(formatSessionTime(0)).toBe("0s");
		expect(formatSessionTime(999)).toBe("0s");
		expect(formatSessionTime(1_000)).toBe("1s");
		expect(formatSessionTime(59_000)).toBe("59s");
	});

	test("under 60m reports minutes + seconds", () => {
		expect(formatSessionTime(60_000)).toBe("1m 0s");
		expect(formatSessionTime(62_500)).toBe("1m 2s");
		expect(formatSessionTime(59 * 60_000 + 30_000)).toBe("59m 30s");
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
