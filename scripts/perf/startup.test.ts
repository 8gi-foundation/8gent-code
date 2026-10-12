import { describe, expect, test } from "bun:test";
import { checkBudget, stat } from "./startup";

describe("perf stats", () => {
	test("median and nearest-rank p90", () => {
		const s = stat([50, 10, 30, 20, 40]);
		expect(s.median).toBe(30);
		expect(s.p90).toBe(50);
		expect(s.min).toBe(10);
		expect(stat([10, 20, 30, 40]).median).toBe(25);
	});
});

describe("budget check", () => {
	const budget = { linux: { a: 100, b: null as number | null } };
	test("fails only above budget x 1.25", () => {
		expect(checkBudget({ a: 125 }, budget, "linux")).toEqual([]);
		expect(checkBudget({ a: 126 }, budget, "linux")).toHaveLength(1);
	});
	test("null, missing and unknown-platform budgets are report-only", () => {
		expect(checkBudget({ b: 99999, c: 99999 }, budget, "linux")).toEqual([]);
		expect(checkBudget({ a: 99999 }, budget, "darwin")).toEqual([]);
	});
});
