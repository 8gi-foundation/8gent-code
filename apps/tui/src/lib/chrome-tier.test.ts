import { describe, expect, test } from "bun:test";
import { KEYS_UP_BELOW_ROWS, chromeTier } from "./chrome-tier.js";

describe("chromeTier", () => {
	test("a phone with the keyboard up folds the chrome", () => {
		for (const rows of [10, 13, 14, 15, 16, 19]) expect(chromeTier(rows, 52)).toBe("keys-up");
		expect(chromeTier(14, 40)).toBe("keys-up");
		expect(chromeTier(14, 60)).toBe("keys-up");
	});
	test("the threshold is exclusive", () => {
		expect(chromeTier(KEYS_UP_BELOW_ROWS - 1, 52)).toBe("keys-up");
		expect(chromeTier(KEYS_UP_BELOW_ROWS, 52)).toBe("roomy");
	});
	test("the keyboard closed, or a wide screen, keeps the full layout", () => {
		for (const rows of [20, 23, 24, 30, 44]) expect(chromeTier(rows, 52)).toBe("roomy");
		expect(chromeTier(14, 61)).toBe("roomy");
		expect(chromeTier(14, 100)).toBe("roomy");
		expect(chromeTier(32, 100)).toBe("roomy");
	});
});
