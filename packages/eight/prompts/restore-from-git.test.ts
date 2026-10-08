/** #3718: a deleted tracked file is restored from git, never retyped. */
import { describe, expect, test } from "bun:test";
import { TOOL_PATTERNS_SEGMENT, getFullSystemPrompt } from "./system-prompt";

const section = TOOL_PATTERNS_SEGMENT.slice(TOOL_PATTERNS_SEGMENT.indexOf("### Recovering a lost file"));

describe("lost file recovery guidance", () => {
	test("uncommitted deletion uses git restore", () => {
		expect(section).toContain('" D <path>"');
		expect(section).toContain("git restore <path>");
	});
	test("committed deletion restores from the parent of the deleting commit", () => {
		expect(section).toContain("git log --diff-filter=D --oneline -- <path>");
		expect(section).toContain("deleting commit");
		expect(section).toContain("git checkout <sha>^ -- <path>");
	});
	test("does not claim checkout HEAD is a no-op in general", () => {
		expect(section).not.toContain("does nothing");
	});
	test("keeps verify and never-retype lines, within size budget", () => {
		expect(section).toContain("never retype");
		expect(section).toContain("must print nothing");
		expect(section.length).toBeLessThan(560);
	});
	test("reaches the full prompt", () => {
		expect(getFullSystemPrompt()).toContain("Recovering a lost file");
	});
});
