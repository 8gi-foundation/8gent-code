/**
 * The compaction row and /compact reports (#4958).
 */
import { describe, expect, test } from "bun:test";
import {
	COMPACTION_MAX_SUMMARY_LINES,
	type CompactionNote,
	compactReport,
	compactionHeadline,
	compactionLines,
	compactionRows,
	undoReport,
} from "./compaction-view.js";

const note = (over: Partial<CompactionNote> = {}): CompactionNote => ({
	tokensBefore: 41000,
	tokensAfter: 9000,
	messagesRemoved: 27,
	summary: "## Goal\nFix the tie-break in score.ts\n\n## Progress\nDone: reproduced the failure.",
	filesRead: ["score.ts"],
	filesModified: ["score.test.ts"],
	expanded: false,
	...over,
});

describe("headline", () => {
	test("reads 'Compacted from N to M tokens' with the numbers people read", () => {
		expect(compactionHeadline(note())).toBe("Compacted from 41k to 9k tokens");
		expect(compactionHeadline(note({ tokensBefore: 3100, tokensAfter: 842 }))).toBe(
			"Compacted from 3.1k to 842 tokens",
		);
	});
});

describe("a very narrow row", () => {
	test("under 36 columns the headline drops 'from' so it fits beside its marker", () => {
		for (const w of [28, 30, 32, 35]) {
			const head = compactionLines(note(), w)[0]!.text;
			expect(head).toBe("Compacted 41k to 9k tokens");
			expect(head.length + 2).toBeLessThanOrEqual(w);
		}
		expect(compactionLines(note(), 36)[0]!.text).toBe("Compacted from 41k to 9k tokens");
	});
});

describe("collapsed", () => {
	test("two lines at every width, the headline first, the way to open it second", () => {
		for (const w of [38, 52, 60, 100]) {
			const lines = compactionLines(note(), w);
			expect(lines.length).toBe(2);
			expect(lines[0]).toEqual({ text: "Compacted from 41k to 9k tokens", kind: "head" });
			expect(lines[1]!.kind).toBe("hint");
			expect(lines[1]!.text).toContain("/compact");
		}
	});

	test("no line is wider than a 40 column phone's text", () => {
		for (const l of compactionLines(note(), 38)) expect(l.text.length).toBeLessThanOrEqual(38);
		for (const l of compactionLines(note({ expanded: true }), 38)) {
			expect(l.text.length).toBeLessThanOrEqual(38);
		}
	});

	test("wide: names the messages summarized and the undo", () => {
		const hint = compactionLines(note(), 100)[1]!.text;
		expect(hint).toContain("27 messages summarized");
		expect(hint).toContain("/compact undo");
	});
});

describe("expanded", () => {
	test("shows the summary, the files and how to fold it", () => {
		const texts = compactionLines(note({ expanded: true }), 52).map((l) => l.text);
		expect(texts).toContain("## Goal");
		expect(texts).toContain("Fix the tie-break in score.ts");
		expect(texts).toContain("read: score.ts");
		expect(texts).toContain("modified: score.test.ts");
		expect(texts.at(-1)).toContain("fold");
	});

	test("wraps a long summary line at the width and never cuts a word in two", () => {
		const long = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi";
		const lines = compactionLines(note({ expanded: true, summary: long }), 30)
			.filter((l) => l.kind === "body")
			.map((l) => l.text);
		expect(lines.length).toBeGreaterThan(1);
		for (const l of lines) expect(l.length).toBeLessThanOrEqual(28);
		expect(lines.join(" ")).toContain("kappa lambda");
	});

	test("a very long summary is capped, and says how many lines it left out", () => {
		const summary = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
		const lines = compactionLines(
			note({ expanded: true, summary, filesRead: [], filesModified: [] }),
			60,
		);
		const body = lines.filter((l) => l.kind === "body");
		expect(body.length).toBe(COMPACTION_MAX_SUMMARY_LINES + 1);
		expect(body.at(-1)!.text).toBe(`... ${200 - COMPACTION_MAX_SUMMARY_LINES} more lines`);
	});

	test("an empty summary still says something true", () => {
		const texts = compactionLines(note({ expanded: true, summary: "" }), 60).map((l) => l.text);
		expect(texts).toContain("No summary was kept.");
	});

	test("rows are the lines plus the blank row after", () => {
		const n = note({ expanded: true });
		expect(compactionRows(n, 52)).toBe(compactionLines(n, 52).length + 1);
		expect(compactionRows(note(), 52)).toBe(3);
	});
});

describe("reports", () => {
	test("/compact reports real tokens before and after, and the way back", () => {
		const out = compactReport({ tokensBefore: 41000, tokensAfter: 9000, messagesRemoved: 27 });
		expect(out).toContain("Compacted from 41k to 9k tokens");
		expect(out).toContain("27 messages");
		expect(out).toContain("/compact undo");
	});
	test("undo says what it restored", () => {
		expect(undoReport(41000)).toContain("41k tokens");
	});
});
