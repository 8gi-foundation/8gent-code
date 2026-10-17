/**
 * #4401: collab-support-unblock FAILED no_invented_paths twice. PRIYA.txt never says where
 * Tally lives, so the model wrote `cd C:\path\to\Tally` into UNBLOCK.md. A written prose doc
 * now draws a one-line nudge when it names a placeholder folder the task never gave.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { placeholderPathLine } from "./placeholder-paths";
import { ToolExecutor } from "./tools";

afterAll(cleanupTempDirs);

const NUDGE =
	"does not say where that folder is. Name the folder in words (the folder where the project is) or use a path relative to the project.";

describe("placeholderPathLine", () => {
	test("flags the pilot's backslash path", () => {
		const out = placeholderPathLine(
			"UNBLOCK.md",
			"Open a terminal.\n\ncd C:\\path\\to\\Tally\nnode tally.js\n",
			[],
		);
		expect(out).toContain("C:\\path\\to\\Tally");
		expect(out).toContain(NUDGE);
		expect(out.includes("\n")).toBe(false);
	});

	test("flags the pilot's lowercase file path from run 4", () => {
		expect(
			placeholderPathLine("a.md", "Run c:\\path\\to\\tally\\src\\tally.js now.", []),
		).toContain("c:\\path\\to\\tally\\src\\tally.js");
	});

	test("flags the forward-slash styles", () => {
		for (const text of [
			"cd /path/to/Tally",
			"cd /path/to/your/project",
			"open ~/path/to/tally",
			"see /Users/yourname/Tally",
			"see C:\\Users\\<username>\\Tally",
			"cd <your-project-folder>/src",
			"cd /your/project/folder",
		]) {
			expect([text, placeholderPathLine("a.txt", text, []) !== ""]).toEqual([text, true]);
		}
	});

	test("a real path present in the task inputs passes untouched", () => {
		expect(
			placeholderPathLine("a.md", "cd C:\\path\\to\\Tally", [
				"Tally lives at C:\\path\\to\\Tally on Priya's PC.",
			]),
		).toBe("");
		expect(placeholderPathLine("a.md", "cd /path/to/tally", ["it is in /PATH/TO/TALLY"])).toBe("");
	});

	test("a real path passes: no placeholder shape", () => {
		for (const text of [
			"cd C:\\Users\\priya\\Documents\\Tally",
			"cd /home/priya/tally",
			"cd Tally",
			"cd ./Tally/src",
			"The path to the folder is the one you chose.",
			"Add the path to PATH, then to the file.",
		]) {
			expect([text, placeholderPathLine("a.md", text, [])]).toEqual([text, ""]);
		}
	});

	test("non-prose files are ignored", () => {
		const code = "const p = 'C:\\\\path\\\\to\\\\Tally'; // /path/to/x";
		for (const f of [
			"tally.js",
			"run.sh",
			"config.json",
			"a.py",
			"page.html",
			"Makefile",
			"notes",
		]) {
			expect([f, placeholderPathLine(f, code, [])]).toEqual([f, ""]);
		}
		expect(placeholderPathLine("DOC.MD", "cd /path/to/x", [])).not.toBe("");
	});

	test("a URL is not an invented folder", () => {
		expect(placeholderPathLine("a.md", "See https://example.com/path/to/page for more.", [])).toBe(
			"",
		);
		expect(placeholderPathLine("a.md", "See <https://example.com/path/to/page>.", [])).toBe("");
	});

	test("a fenced code block is still checked", () => {
		expect(placeholderPathLine("a.md", "```\ncd C:\\path\\to\\Tally\n```", [])).toContain("path");
	});

	test("an unbroken 200 KB run of matches finishes fast", () => {
		const text = "/path/to/x".repeat(20_000);
		const t = performance.now();
		const out = placeholderPathLine("a.md", text, []);
		expect(performance.now() - t).toBeLessThan(500);
		expect(out).toContain("[Placeholder path]");
		expect(out.length).toBeLessThan(1000);
	});

	test("one line, at most three paths named", () => {
		const out = placeholderPathLine("a.md", "/path/to/a /path/to/b /path/to/c /path/to/d", []);
		expect(out.split("\n")).toHaveLength(1);
		expect(out).toContain("/path/to/c");
		expect(out).not.toContain("/path/to/d");
	});
});

describe("through ToolExecutor", () => {
	const doc = "# Unblock\n\ncd C:\\path\\to\\Tally\n";

	test("write_file on a doc nudges; a path the task gave does not", async () => {
		const ex = new ToolExecutor(tempDir("placeholder-"));
		ex.beginTurn("Help Priya run Tally.");
		const out = await ex.execute("write_file", { path: "UNBLOCK.md", content: doc });
		expect(out).toContain("C:\\path\\to\\Tally");
		expect(out).toContain(NUDGE);

		const ex2 = new ToolExecutor(tempDir("placeholder-"));
		ex2.beginTurn("Tally is at C:\\path\\to\\Tally.");
		expect(await ex2.execute("write_file", { path: "UNBLOCK.md", content: doc })).not.toContain(
			NUDGE,
		);
	});

	test("a path inside a file read this turn passes", async () => {
		const dir = tempDir("placeholder-");
		const ex = new ToolExecutor(dir);
		await ex.execute("write_file", {
			path: "PRIYA.txt",
			content: "Tally is in C:\\path\\to\\Tally.",
		});
		ex.beginTurn("Write the guide.");
		await ex.execute("read_file", { path: "PRIYA.txt" });
		expect(await ex.execute("write_file", { path: "G.md", content: doc })).not.toContain(NUDGE);
	});

	test("write_file on code is untouched", async () => {
		const ex = new ToolExecutor(tempDir("placeholder-"));
		ex.beginTurn("x");
		expect(await ex.execute("write_file", { path: "t.js", content: doc })).not.toContain(NUDGE);
	});

	test("edit_file nudges on the new text", async () => {
		const ex = new ToolExecutor(tempDir("placeholder-"));
		ex.beginTurn("x");
		await ex.execute("write_file", { path: "U.md", content: "Go to FOLDER.\n" });
		const out = await ex.execute("edit_file", {
			path: "U.md",
			oldText: "FOLDER",
			newText: "/path/to/Tally",
		});
		expect(out).toContain("File edited");
		expect(out).toContain(NUDGE);
	});
});
