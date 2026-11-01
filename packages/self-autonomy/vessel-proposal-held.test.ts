import { describe, expect, test } from "bun:test";
import { fixedChecks, heldForRuns, regressedChecks } from "./vessel-proposal-held";

const run = (runId: string, checks: Record<string, "pass" | "fail">) => ({
	runId,
	checks,
});

describe("fixedChecks / regressedChecks", () => {
	test("a check that went fail to pass is fixed", () => {
		expect(
			fixedChecks({ b: "fail", a: "fail", c: "pass" }, { a: "pass", b: "pass", c: "pass" }),
		).toEqual(["a", "b"]);
	});
	test("a check that went pass to fail is regressed", () => {
		expect(regressedChecks({ a: "pass", b: "pass" }, { a: "fail", b: "pass" })).toEqual(["a"]);
	});
	test("a check missing before is not passing, so it counts as fixed once it passes", () => {
		expect(fixedChecks({}, { a: "pass" })).toEqual(["a"]);
	});
	test("a check missing after cannot count as fixed and counts as regressed", () => {
		expect(fixedChecks({ a: "fail" }, {})).toEqual([]);
		expect(regressedChecks({ a: "pass" }, {})).toEqual(["a"]);
	});
});

describe("heldForRuns", () => {
	test("true when nothing regresses across the window", () => {
		const h = [
			run("1", { a: "pass", b: "fail" }),
			run("2", { a: "pass", b: "pass" }),
			run("3", { a: "pass", b: "pass" }),
		];
		expect(heldForRuns(h, 3)).toBe(true);
	});
	test("history shorter than N returns false", () => {
		expect(heldForRuns([run("1", { a: "pass" })], 2)).toBe(false);
	});
	test("a single regression inside the window returns false", () => {
		const h = [run("1", { a: "pass" }), run("2", { a: "fail" }), run("3", { a: "pass" })];
		expect(heldForRuns(h, 3)).toBe(false);
	});
	test("a check missing from one run is not passing, so it regresses", () => {
		const h = [run("1", { a: "pass" }), run("2", {}), run("3", { a: "pass" })];
		expect(heldForRuns(h, 3)).toBe(false);
	});
	test("runs before the window are ignored", () => {
		const h = [run("0", { a: "pass" }), run("1", { a: "fail" }), run("2", { a: "fail" })];
		expect(heldForRuns(h, 2)).toBe(true);
	});
	test("non-positive N returns false", () => {
		expect(heldForRuns([run("1", { a: "pass" })], 0)).toBe(false);
	});
});
