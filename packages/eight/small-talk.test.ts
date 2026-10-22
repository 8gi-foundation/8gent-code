/**
 * Small-talk gate (#4756): a greeting alone gets no tools, and a home folder
 * that is not a repo is not described to the model as a project.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPlainHome, workingProjectNote } from "./prompts/system-prompt";
import { isSmallTalk } from "./small-talk";

describe("isSmallTalk", () => {
	test("a greeting or pleasantry alone is small talk", () => {
		for (const t of [
			"hi",
			"Hi!",
			"hello",
			"hey there",
			"what upp",
			"what up",
			"what's up?",
			"whats up",
			"wassup",
			"sup",
			"yo",
			"hey, what's up",
			"good morning",
			"how are you",
			"thanks",
			"ok",
			"[Mode: Implementing] hi",
		])
			expect({ t, v: isSmallTalk(t) }).toEqual({ t, v: true });
	});

	test("anything that carries a task, or is not a greeting, is not", () => {
		for (const t of [
			"",
			"hi, run the tests",
			"what up with the build",
			"hello world program in rust",
			"what is in my home folder",
			"hey can you check git status",
			"thanks, now fix the bug",
			"ok go ahead and deploy",
			"hi hi hi hi hi hi hi hi hi hi hi hi hi hi hi hi",
		])
			expect({ t, v: isSmallTalk(t) }).toEqual({ t, v: false });
	});
});

describe("home folder that is not a repo", () => {
	test("is named as not a project; a repo or another folder is not", () => {
		const saved = process.env.EIGHT_HOME;
		const home = mkdtempSync(join(tmpdir(), "home-"));
		process.env.EIGHT_HOME = home;
		try {
			expect(isPlainHome(home)).toBe(true);
			expect(workingProjectNote(home)).toContain("is the person's home folder, not a project");
			mkdirSync(join(home, "work"));
			expect(workingProjectNote(join(home, "work"))).not.toContain("home folder");
			mkdirSync(join(home, ".git"));
			expect(isPlainHome(home)).toBe(false);
			expect(workingProjectNote(home)).not.toContain("home folder");
		} finally {
			rmSync(home, { recursive: true, force: true });
			if (saved === undefined) {
				// biome-ignore lint/performance/noDelete: an env var set to undefined becomes the string "undefined"
				delete process.env.EIGHT_HOME;
			} else process.env.EIGHT_HOME = saved;
		}
	});
});
