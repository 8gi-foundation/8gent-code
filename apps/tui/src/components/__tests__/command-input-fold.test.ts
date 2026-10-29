import { describe, expect, test } from "bun:test";
import { DRAFT_FOLD_ROWS, draftRows, draftSummary } from "../command-input";

describe("draft fold", () => {
	test("a short draft stays under the fold at 40 columns", () => {
		expect(draftRows("fix the footer so stop stays visible", 36)).toBeLessThanOrEqual(
			DRAFT_FOLD_ROWS,
		);
	});
	test("a 30 line paste is far over the fold", () => {
		const log = Array.from({ length: 30 }, (_, i) => `tool call ${i}`).join("\n");
		expect(draftRows(log, 96)).toBe(30);
	});
	test("a long paragraph counts its wrapped rows", () => {
		expect(draftRows("x".repeat(962), 36)).toBe(27);
	});
	test("summary names lines for multi-line, chars for one line, shorter when narrow", () => {
		expect(draftSummary("a\nb\nc", false)).toContain("3 lines");
		expect(draftSummary("x".repeat(962), false)).toContain("962 chars");
		expect(draftSummary("a\nb", true).length).toBeLessThan(draftSummary("a\nb", false).length);
	});
});
