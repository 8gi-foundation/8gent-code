import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createSessionScratch,
	removeSessionScratch,
	sessionScratchNote,
	sessionScratchPath,
} from "./session-scratch";

describe("session scratch dir (#4711)", () => {
	test("lives at $TMPDIR/8gent-<session id>/, outside any repo", () => {
		expect(sessionScratchPath("session_1_abc")).toBe(join(tmpdir(), "8gent-session_1_abc"));
	});

	test("created at start, removed with its contents at the end, twice is fine", () => {
		const dir = createSessionScratch("session_test_4711") as string;
		expect(existsSync(dir)).toBe(true);
		writeFileSync(join(dir, "scratch.txt"), "x");
		removeSessionScratch(dir);
		expect(existsSync(dir)).toBe(false);
		removeSessionScratch(dir);
		removeSessionScratch(null);
	});

	test("the prompt block names the directory and forbids scratch in the repo", () => {
		const note = sessionScratchNote("/tmp/x/8gent-s");
		expect(note).toContain("/tmp/x/8gent-s/");
		expect(note).toContain("Never create scratch files");
		expect(sessionScratchNote(null)).toBe("");
	});
});
