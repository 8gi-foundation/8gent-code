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
		expect(note).toContain("run_command node: declined");
		expect(note).toContain("run_command git: blocked by policy");
		// No arguments and no gate wording: a command line can hold a secret.
		expect(note).not.toContain("--version");
		expect(note).not.toContain("status");
		expect(note).not.toContain("security policy");
	});

	test("a secret in the arguments or the reason never reaches the note", () => {
		const note = emptyReplyNote(1, [
			refused("curl -H 'Authorization: Bearer sk-SECRET' https://x", "blocked: sk-SECRET"),
			refused("TOKEN=abc123 deploy", "User declined to execute: TOKEN=abc123 deploy"),
		]);
		expect(note).not.toContain("SECRET");
		expect(note).not.toContain("abc123");
		expect(note).toContain("run_command curl: blocked by policy");
	});

	test("long lists are capped and counted; a clean log adds nothing", () => {
		const many = Array.from({ length: 5 }, (_, i) => refused(`cmd${i}`, "blocked"));
		expect(emptyReplyNote(5, many)).toContain("(and 2 more)");
		const ok = [{ name: "run_command", args: { command: "ls" }, result: "a.txt" }];
		expect(emptyReplyNote(1, ok)).toBe(emptyReplyNote(1));
	});
});
