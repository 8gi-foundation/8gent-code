/** #3718: a deleted tracked file is restored from git, never retyped. */
import { describe, expect, test } from "bun:test";
import { TOOL_PATTERNS_SEGMENT, getFullSystemPrompt } from "./system-prompt";

describe("lost file recovery guidance", () => {
	test("tells the agent to restore from the last commit that had the file", () => {
		expect(TOOL_PATTERNS_SEGMENT).toContain("git checkout <sha> -- <path>");
		expect(TOOL_PATTERNS_SEGMENT).toContain("git log --all --oneline -- <path>");
	});
	test("forbids retyping contents and requires a diff check", () => {
		expect(TOOL_PATTERNS_SEGMENT).toContain("Never retype");
		expect(TOOL_PATTERNS_SEGMENT).toContain("git diff <sha> -- <path>");
	});
	test("reaches the full prompt", () => {
		expect(getFullSystemPrompt()).toContain("Recovering a lost file");
	});
});
