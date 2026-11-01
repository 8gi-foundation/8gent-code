import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// A reply ends where the model ended it. No canned follow-up line is appended
// (8gent-code #5). Say "5 keep" to James's thread to restore it.
describe("no canned closing line", () => {
	test("the closing-prompt module is gone", () => {
		expect(existsSync(join(import.meta.dir, "closing-prompt.ts"))).toBe(false);
	});

	test("app.tsx never appends a steering question", () => {
		const src = readFileSync(join(import.meta.dir, "..", "app.tsx"), "utf8");
		expect(src).not.toContain("appendClosingQuestionIfNeeded");
		expect(src).not.toContain("Where should we steer next");
	});
});
