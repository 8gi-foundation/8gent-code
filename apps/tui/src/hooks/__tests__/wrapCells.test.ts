import { describe, expect, test } from "bun:test";
import { wrapCells } from "../useApprovalCard.js";

const CMD = "bun test packages/permissions/policy-engine.test.ts --bail";

describe("wrapCells", () => {
	test("keeps every character", () => {
		for (const w of [10, 20, 36, 40, 60]) expect(wrapCells(CMD, w).join("")).toBe(CMD);
	});
	test("breaks after a path mark, so no line starts with one", () => {
		const lines = wrapCells(CMD, 36);
		expect(lines).toEqual(["bun test packages/permissions/", "policy-engine.test.ts --bail"]);
		for (const l of lines.slice(1)) expect("/-.".includes(l[0])).toBe(false);
	});
	test("a token longer than half a line is still cut hard", () => {
		expect(wrapCells("a".repeat(25), 10)).toEqual(["a".repeat(10), "a".repeat(10), "a".repeat(5)]);
	});
	test("no line is wider than the width", () => {
		for (const l of wrapCells(CMD, 20)) expect([...l].length).toBeLessThanOrEqual(20);
	});
});
