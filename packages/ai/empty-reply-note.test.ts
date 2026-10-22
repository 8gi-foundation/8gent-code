import { describe, expect, test } from "bun:test";
import { emptyReplyNote } from "./text-tool-loop";

describe("emptyReplyNote after refused calls (#4756)", () => {
	const refused = (command: string, why: string) => ({
		name: "run_command",
		args: { command },
		result: `[PERMISSION DENIED] ${why}`,
	});

	test("a turn where every call was refused says what was refused and why", () => {
		const log = [
			refused("node --version", "User declined to execute: node --version"),
			refused("git status", "Command blocked by security policy"),
		];
		const note = emptyReplyNote(2, log);
		expect(note.startsWith(emptyReplyNote(2))).toBe(true);
		expect(note).toContain("2 of the calls were refused, so they did not run");
		expect(note).toContain('run_command "node --version": User declined to execute');
		expect(note).toContain('run_command "git status": Command blocked by security policy');
	});

	test("long lists are capped and counted; a clean log adds nothing", () => {
		const many = Array.from({ length: 5 }, (_, i) => refused(`cmd${i}`, "blocked"));
		expect(emptyReplyNote(5, many)).toContain("(and 2 more)");
		const ok = [{ name: "run_command", args: { command: "ls" }, result: "a.txt" }];
		expect(emptyReplyNote(1, ok)).toBe(emptyReplyNote(1));
	});
});
