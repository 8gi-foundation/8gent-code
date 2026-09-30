import { describe, expect, test } from "bun:test";
import { keepIfSame } from "./keep-if-same.js";

describe("keepIfSame", () => {
	test("same data keeps the previous reference, so React bails out", () => {
		const prev = { running: 0, done: 2, list: [{ id: "a" }] };
		expect(keepIfSame({ running: 0, done: 2, list: [{ id: "a" }] })(prev)).toBe(prev);
	});

	test("changed data takes the new value", () => {
		const prev = { running: 0, done: 2 };
		const next = { running: 1, done: 2 };
		expect(keepIfSame(next)(prev)).toBe(next);
	});

	test("null and primitives compare by value", () => {
		expect(keepIfSame<number | null>(null)(null)).toBeNull();
		expect(keepIfSame(3)(3)).toBe(3);
		expect(keepIfSame<number | null>(3)(null)).toBe(3);
	});
});
