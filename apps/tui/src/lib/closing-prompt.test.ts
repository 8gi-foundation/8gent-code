import { describe, expect, test } from "bun:test";
import { appendClosingQuestionIfNeeded } from "./closing-prompt.js";

const reply = [
	{
		role: "assistant",
		content:
			"Hi, I'm 8gent. This folder (~) is not a git repo. I won't look through it unless you ask.",
	},
];

describe("closing question", () => {
	test("in a git repo it still offers the repo wording", () => {
		const out = appendClosingQuestionIfNeeded(reply, true);
		expect(out[0].content).toContain("another part of the repo");
	});

	test("outside a git repo it never mentions the repo", () => {
		const out = appendClosingQuestionIfNeeded(reply, false);
		expect(out[0].content).toContain("Where should we steer next");
		expect(out[0].content).not.toContain("repo, or");
		expect(out[0].content.endsWith("deeper here, or something new to build?")).toBe(true);
	});

	test("a reply that already asks is left alone", () => {
		const asked = [{ role: "assistant", content: "x".repeat(60) + " Which file should I open?" }];
		expect(appendClosingQuestionIfNeeded(asked, false)).toBe(asked);
	});
});
