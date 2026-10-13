/**
 * #4161: a checklist file the task points at is the record, not the rail.
 * Pilot run 2026-10-13_074318 ticked the update_plan rail and left PLAN.md's
 * boxes open. The line (approved by 8PO) sits right after the rail sentence
 * and must reach the full and tiered prompts.
 */

import { describe, expect, test } from "bun:test";
import {
	TASK_DISCIPLINE_SEGMENT,
	buildTieredSystemPrompt,
	getFullSystemPrompt,
} from "./system-prompt";

const LINE =
	"If the task points at a checklist file (PLAN.md, TODO.md or one it names),\nthat file is the record, not the rail: tick each box in the file with\nedit_file as its step finishes. update_plan only mirrors it.";

describe("checklist file is the record", () => {
	test("follows the rail sentence in the task discipline segment", () => {
		const rail = TASK_DISCIPLINE_SEGMENT.indexOf("where we have been and what is open.");
		expect(rail).toBeGreaterThan(-1);
		expect(TASK_DISCIPLINE_SEGMENT.indexOf(LINE)).toBe(
			rail + "where we have been and what is open.\n".length,
		);
	});

	test("reaches the full and tiered prompts", () => {
		expect(getFullSystemPrompt()).toContain(LINE);
		expect(buildTieredSystemPrompt("owner")).toContain(LINE);
	});
});
