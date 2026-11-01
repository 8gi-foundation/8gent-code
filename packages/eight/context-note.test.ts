import { describe, expect, test } from "bun:test";
import { CONTEXT_NOTE_HEADER, contextNote } from "./context-note";

const base = { memory: "", appendedContext: [] as string[], voiceChatActive: false };

describe("contextNote (#3222)", () => {
	test("nothing to say: no message", () => {
		expect(contextNote(base, {}).note).toBeNull();
	});

	test("memories go out once, then never again", () => {
		const first = contextNote({ ...base, memory: "\n\n## What I know about you\n- x" }, {});
		expect(first.note?.startsWith(CONTEXT_NOTE_HEADER)).toBe(true);
		expect(first.note).toContain("- x");
		expect(
			contextNote({ ...base, memory: "\n\n## What I know about you\n- x" }, first.sent).note,
		).toBeNull();
	});

	test("only the changed section is sent", () => {
		const s1 = contextNote({ ...base, memory: "M", appendedContext: ["a"] }, {}).sent;
		const n2 = contextNote({ ...base, memory: "M", appendedContext: ["a", "b"] }, s1).note ?? "";
		expect(n2).toContain("[1] a\n[2] b");
		expect(n2).not.toContain("M");
	});

	test("voice off is announced once after voice on, and never before it", () => {
		const on = contextNote({ ...base, voiceChatActive: true }, {});
		expect(on.note).toContain("Voice Chat Mode (active)");
		const off = contextNote(base, on.sent);
		expect(off.note).toContain("Voice Chat Mode (off)");
		expect(contextNote(base, off.sent).note).toBeNull();
	});

	test("cleared appended context is announced, not silently kept", () => {
		const s1 = contextNote({ ...base, appendedContext: ["a"] }, {}).sent;
		expect(contextNote(base, s1).note).toContain("## Agent Self-Appended Context\n(none)");
	});
});
