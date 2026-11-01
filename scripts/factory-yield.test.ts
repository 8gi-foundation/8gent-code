import { describe, expect, test } from "bun:test";
import {
	countSteeringRounds,
	hoursBetween,
	parseLinkedIssue,
	parseSteeringLedger,
	parseTokensLedger,
	renderTable,
} from "./factory-yield";

describe("parseLinkedIssue", () => {
	test("finds closes, fixes, resolves case-insensitively", () => {
		expect(parseLinkedIssue("Closes #12")).toBe(12);
		expect(parseLinkedIssue("this fixes  #7 today")).toBe(7);
		expect(parseLinkedIssue("RESOLVES #301")).toBe(301);
	});
	test("returns null when absent or Refs only", () => {
		expect(parseLinkedIssue("Refs #4942")).toBeNull();
		expect(parseLinkedIssue(null)).toBeNull();
	});
});

describe("parseLinkedIssue hardening", () => {
	test("rejects numbers beyond the safe integer range", () => {
		expect(parseLinkedIssue("Closes #99999999999999999999999")).toBeNull();
	});
	test("rejects zero", () => {
		expect(parseLinkedIssue("Closes #0")).toBeNull();
	});
});

describe("parseSteeringLedger", () => {
	const R = "8gi-foundation/8gent-code";
	const h = (c: string) => c.repeat(40);
	// inline fixture in the review-ledger line shapes
	const fixture = [
		"# Merge-ready queue",
		`MERGE-OK ${R}#4929 at ${h("a")}: second read PASS`,
		`MERGE-OK ${R}#4929 at ${h("b")}: second read PASS`,
		`MERGE-OK ${R}#4929 at ${h("b")}: repeated line, same head`,
		`MERGE-OK ${R}#4929 at ${h("c")}: second read PASS`,
		`NOTE 8gent-code#4936 at ${h("d").slice(0, 8)}: 8SO HOLD, FIX FIRST. fix lint`,
		`MERGE-OK ${R}#4936 at ${h("e")}: second read PASS`,
		`NOTE 8gent-code#5000 at abcdef12: just a note`,
		"3699 28e93e78b008b6236c8ef4732f124d96651a3204 T131",
	].join("\n");
	test("#4929 scores 3 distinct reviewed heads, #4936 scores 2", () => {
		const m = parseSteeringLedger(fixture);
		expect(m.get(4929)).toBe(3);
		expect(m.get(4936)).toBe(2);
		expect(m.has(5000)).toBe(false);
	});
	test("survives stray binary bytes", () => {
		const m = parseSteeringLedger(`\u0000\u0001junk\n${fixture}`);
		expect(m.get(4929)).toBe(3);
	});
});

describe("parseTokensLedger", () => {
	test("skips malformed lines and invalid rows", () => {
		const m = parseTokensLedger(
			[
				"not json",
				'{"pr": 1, "tokens": 10}',
				'{"pr": -2, "tokens": 5}',
				'{"pr": 1.5, "tokens": 5}',
				'{"pr": 3, "tokens": -1}',
				'{"pr": 4, "tokens": "9"}',
				"null",
				"",
			].join("\n"),
		);
		expect([...m.entries()]).toEqual([[1, 10]]);
	});
	test("sums duplicate PRs", () => {
		const m = parseTokensLedger('{"pr": 7, "tokens": 100}\n{"pr": 7, "tokens": 50}');
		expect(m.get(7)).toBe(150);
	});
	test("overflow to Infinity is dropped, not rendered", () => {
		const m = parseTokensLedger('{"pr": 9, "tokens": 1e308}\n{"pr": 9, "tokens": 1e308}');
		expect(Number.isFinite(m.get(9) ?? 0)).toBe(true);
	});
});

describe("countSteeringRounds", () => {
	test("counts CHANGES_REQUESTED reviews and FIX FIRST comments", () => {
		const n = countSteeringRounds(
			[{ state: "APPROVED" }, { state: "CHANGES_REQUESTED" }, { state: "CHANGES_REQUESTED" }],
			[{ body: "FIX FIRST: lint" }, { body: "looks fine" }],
			[{ body: "fix first, then retry" }],
		);
		expect(n).toBe(4);
	});
	test("zero when nothing matches", () => {
		expect(countSteeringRounds([], [], [])).toBe(0);
	});
});

describe("hoursBetween", () => {
	test("rounds to one decimal", () => {
		expect(hoursBetween("2026-10-24T00:00:00Z", "2026-10-24T05:30:00Z")).toBe(5.5);
	});
	test("null on bad input", () => {
		expect(hoursBetween("nope", "2026-10-24T00:00:00Z")).toBeNull();
	});
});

describe("renderTable", () => {
	test("renders rows with n/a for missing values", () => {
		const out = renderTable([
			{ pr: 1, title: "a", issue: 9, hours: 2.5, steering: 1, tokens: null },
			{ pr: 2, title: "b", issue: null, hours: null, steering: 0, tokens: 1200 },
		]);
		const lines = out.split("\n");
		expect(lines[0]).toContain("Steering rounds");
		expect(lines[2]).toBe("| #1 | #9 | 2.5 | 1 | n/a |");
		expect(lines[3]).toBe("| #2 | n/a | n/a | 0 | 1200 |");
	});
});
