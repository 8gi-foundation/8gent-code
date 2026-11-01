import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

	test("a pre-existing directory is EEXIST: null, and it is not removed", () => {
		const dir = sessionScratchPath("session_preexisting_4711");
		mkdirSync(dir);
		writeFileSync(join(dir, "theirs.txt"), "x");
		expect(createSessionScratch("session_preexisting_4711")).toBeNull();
		removeSessionScratch(null);
		expect(existsSync(join(dir, "theirs.txt"))).toBe(true);
		rmSync(dir, { recursive: true, force: true });
	});

	test("removal refuses a symlink and a non-directory", () => {
		const real = mkdtempSync(join(tmpdir(), "scr-real-"));
		writeFileSync(join(real, "keep.txt"), "x");
		const link = join(tmpdir(), `8gent-link-${process.pid}`);
		symlinkSync(real, link);
		removeSessionScratch(link);
		expect(existsSync(join(real, "keep.txt"))).toBe(true);
		const file = join(tmpdir(), `8gent-file-${process.pid}`);
		writeFileSync(file, "x");
		removeSessionScratch(file);
		expect(existsSync(file)).toBe(true);
		for (const p of [link, file, real]) rmSync(p, { recursive: true, force: true });
	});

	test("20 scratch dirs add exactly one exit listener", () => {
		const before = process.listenerCount("exit");
		const dirs = Array.from({ length: 20 }, (_, i) =>
			createSessionScratch(`session_many_${i}_4711`),
		);
		expect(dirs.every(Boolean)).toBe(true);
		expect(process.listenerCount("exit") - before).toBeLessThanOrEqual(1);
		const mid = process.listenerCount("exit");
		const more = createSessionScratch("session_many_extra_4711");
		expect(process.listenerCount("exit")).toBe(mid);
		for (const d of [...dirs, more]) removeSessionScratch(d);
	});
});
