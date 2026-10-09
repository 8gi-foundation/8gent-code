import { describe, expect, test } from "bun:test";
import { CHILD_GUIDANCE_MARKER, withChildGuidance } from "./child-guidance";

describe("withChildGuidance (#3784)", () => {
	test("keeps the task verbatim and appends the efficiency rules after it", () => {
		const task = "Fix src/slug.ts and write notes/8TO.md";
		const out = withChildGuidance(task);
		expect(out.startsWith(task)).toBe(true);
		expect(out).toContain(CHILD_GUIDANCE_MARKER);
	});

	test("tells the child to write its note right after the edit, before verifying", () => {
		const out = withChildGuidance("x");
		expect(out).toMatch(/note|output file/i);
		expect(out).toMatch(/before (you )?(run|verif)/i);
	});

	test("tells the child not to re-read a file or repeat a command it already ran", () => {
		const out = withChildGuidance("x");
		expect(out).toMatch(/do not read a file again|re-read/i);
		expect(out).toMatch(/mkdir/i);
	});

	test("is idempotent", () => {
		const once = withChildGuidance("task");
		expect(withChildGuidance(once)).toBe(once);
	});

	test("has no em dash", () => {
		expect(withChildGuidance("t")).not.toContain("—");
	});
});
