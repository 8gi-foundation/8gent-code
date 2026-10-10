/**
 * Review-task guidance (#3786): a code review reports only findings that
 * matter, cites lines of the changed file (not diff rows), and does not pad
 * with nice-to-haves. The text must reach the full and tiered prompts.
 */

import { describe, expect, test } from "bun:test";
import {
	REVIEW_DISCIPLINE_SEGMENT,
	buildTieredSystemPrompt,
	getFullSystemPrompt,
} from "./system-prompt";

describe("review discipline segment", () => {
	test("states the three review rules", () => {
		const s = REVIEW_DISCIPLINE_SEGMENT.toLowerCase();
		expect(s).toContain("review");
		expect(s).toContain("matter");
		expect(s).toContain("line number");
		expect(s).toContain("diff");
		expect(s).toContain("nice-to-have");
	});

	test("asks for one or two proving lines and summarises repeats in words", () => {
		const s = REVIEW_DISCIPLINE_SEGMENT.toLowerCase();
		expect(s).toContain("one or two lines");
		expect(s).toContain("similar call sites");
		expect(s).toContain("instead of listing");
	});

	test("does not mention benchmarks, judges, pilots or numeric limits", () => {
		const s = REVIEW_DISCIPLINE_SEGMENT.toLowerCase();
		for (const word of ["benchmark", "judge", "pilot", "limit", "score"]) {
			expect(s).not.toContain(word);
		}
	});

	test("is short and has no dashes", () => {
		expect(REVIEW_DISCIPLINE_SEGMENT.length).toBeLessThan(1150);
		expect(REVIEW_DISCIPLINE_SEGMENT).not.toMatch(/[–—]/);
	});

	test("is in the full and tiered prompts", () => {
		expect(getFullSystemPrompt()).toContain(REVIEW_DISCIPLINE_SEGMENT);
		expect(buildTieredSystemPrompt("owner")).toContain(REVIEW_DISCIPLINE_SEGMENT);
	});
});
