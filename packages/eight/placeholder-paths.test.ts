/**
 * #4401: collab-support-unblock FAILED no_invented_paths twice. PRIYA.txt never says where
 * Tally lives, so the model wrote `cd C:\path\to\Tally` into UNBLOCK.md. A written prose doc
 * now draws a one-line nudge when it names a placeholder folder the task never gave.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { placeholderPathLine } from "./placeholder-paths";
import { ToolExecutor } from "./tools";

afterAll(cleanupTempDirs);

const NUDGE =
	"does not say where that folder is. In commands, do not put a made-up or described folder inside the path; tell the reader to open or cd into the project folder first, then use the path relative to it (for example `node src/app.js`).";

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
			"cd %USERPROFILE%\\Tally",
			"cd Tally",
			"cd ./Tally/src",
			"The path to the folder is the one you chose.",
			"Add the path to PATH, then to the file.",
		]) {
			expect([text, placeholderPathLine("a.md", text, [])]).toEqual([text, ""]);
		}
	});

	test("a plausible invented absolute path is flagged (#4405)", () => {
		for (const text of [
			"node c:\\users\\priya\\tally\\src\\tally.js",
			"cd C:\\Users\\priya\\Documents\\Tally",
			"cd D:/work/tally",
			"cd /home/priya/tally",
			"cd /Users/priya/tally",
			"cd ~/tally",
		]) {
			expect([text, placeholderPathLine("a.md", text, ["Help Priya run Tally."])[0]]).toEqual([
				text,
				"[",
			]);
		}
		expect(placeholderPathLine("a.md", "cd c:\\users\\priya\\tally", [])).toContain(
			"c:\\users\\priya\\tally",
		);
	});

	test("a given folder, or a child of it, passes (#4405)", () => {
		const given = ["PRIYA.txt: Tally is in C:\\Tools\\node and /home/priya/tally."];
		for (const text of [
			"C:\\Tools\\node\\node.exe C:\\Tools\\node\\src\\tally.js",
			"c:/tools/NODE/node.exe",
			"cd C:\\Tools\\node",
			"cd /HOME/priya/tally/src",
		]) {
			expect([text, placeholderPathLine("a.md", text, given)]).toEqual([text, ""]);
		}
		// A folder that merely shares a name prefix with a given one is not the given folder.
		expect(placeholderPathLine("a.md", "cd C:\\Toolsets\\node", given)).not.toBe("");
		// A bare root given says nothing about where a project lives.
		expect(placeholderPathLine("a.md", "cd /Users/priya/tally", ["see /Users/ and ~"])).not.toBe(
			"",
		);
	});

	test("an absolute path in non-prose or a URL is untouched (#4405)", () => {
		expect(placeholderPathLine("a.js", "cd /Users/priya/tally", [])).toBe("");
		expect(
			placeholderPathLine(
				"a.md",
				"See https://example.com/home/priya and http://x.io/Users/a.",
				[],
			),
		).toBe("");
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
		await ex.execute("write_file", { path: "UNBLOCK.md", content: doc });
		const out = await ex.execute("write_file", { path: "UNBLOCK.md", content: doc });
		expect(out).toContain("C:\\path\\to\\Tally");
		expect(out).toContain(NUDGE);

		const ex2 = new ToolExecutor(tempDir("placeholder-"));
		ex2.beginTurn("Tally is at C:\\path\\to\\Tally.");
		expect(await ex2.execute("write_file", { path: "UNBLOCK.md", content: doc })).not.toContain(
			NUDGE,
		);
	});

	test("refusal names the tool to call again (#4405)", async () => {
		const ex = new ToolExecutor(tempDir("placeholder-"));
		ex.beginTurn("x");
		const w = await ex.execute("write_file", {
			path: "U.md",
			content: "cd c:\\users\\priya\\tally\n",
		});
		expect(w).toContain("Call write_file again with the fixed text.");
		await ex.execute("write_file", { path: "E.md", content: "Go to FOLDER.\n" });
		await ex.execute("write_file", { path: "E.md", content: "Go to FOLDER.\n" });
		const e = await ex.execute("edit_file", {
			path: "E.md",
			oldText: "FOLDER",
			newText: "/home/priya/t",
		});
		expect(e).toContain("Call edit_file again with the fixed text.");
	});

	test("a path inside a file read this turn passes", async () => {
		const dir = tempDir("placeholder-");
		const ex = new ToolExecutor(dir);
		writeFileSync(join(dir, "PRIYA.txt"), "Tally is in C:\\path\\to\\Tally.");
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
		const edit = { path: "U.md", oldText: "FOLDER", newText: "/path/to/Tally" };
		await ex.execute("edit_file", edit);
		const out = await ex.execute("edit_file", edit);
		expect(out).toContain("File edited");
		expect(out).toContain(NUDGE);
	});
});

describe("first write is refused, second goes through (#4405)", () => {
	const doc = "# Unblock\n\ncd C:\\path\\to\\Tally\n";
	const clean = "# Unblock\n\nOpen the Tally folder, then run node src/tally.js\n";

	test("first write is rejected with the nudge and the file is untouched", async () => {
		const dir = tempDir("placeholder-");
		const ex = new ToolExecutor(dir);
		ex.beginTurn("Help Priya run Tally.");
		const out = await ex.execute("write_file", { path: "UNBLOCK.md", content: doc });
		expect(out.startsWith("Error:")).toBe(true);
		expect(out).toContain("nothing was written");
		expect(out).toContain(NUDGE);
		expect(existsSync(join(dir, "UNBLOCK.md"))).toBe(false);
	});

	test("rejection leaves an existing file as it was", async () => {
		const dir = tempDir("placeholder-");
		const ex = new ToolExecutor(dir);
		ex.beginTurn("x");
		await ex.execute("write_file", { path: "U.md", content: clean });
		await ex.execute("write_file", { path: "U.md", content: doc });
		expect(readFileSync(join(dir, "U.md"), "utf-8")).toBe(clean);
	});

	test("second identical write is accepted and lands on disk", async () => {
		const dir = tempDir("placeholder-");
		const ex = new ToolExecutor(dir);
		ex.beginTurn("Help Priya run Tally.");
		await ex.execute("write_file", { path: "UNBLOCK.md", content: doc });
		const out = await ex.execute("write_file", { path: "UNBLOCK.md", content: doc });
		expect(out).toContain("File written");
		expect(readFileSync(join(dir, "UNBLOCK.md"), "utf-8")).toBe(doc);
	});

	test("a different file gets its own first refusal", async () => {
		const ex = new ToolExecutor(tempDir("placeholder-"));
		ex.beginTurn("x");
		await ex.execute("write_file", { path: "A.md", content: doc });
		const out = await ex.execute("write_file", { path: "B.md", content: doc });
		expect(out.startsWith("Error:")).toBe(true);
	});

	test("a clean write is unaffected", async () => {
		const dir = tempDir("placeholder-");
		const ex = new ToolExecutor(dir);
		ex.beginTurn("x");
		const out = await ex.execute("write_file", { path: "G.md", content: clean });
		expect(out).toContain("File written");
		expect(readFileSync(join(dir, "G.md"), "utf-8")).toBe(clean);
	});

	test("non-prose files are unaffected", async () => {
		const dir = tempDir("placeholder-");
		const ex = new ToolExecutor(dir);
		ex.beginTurn("x");
		const out = await ex.execute("write_file", { path: "t.js", content: doc });
		expect(out).toContain("File written");
		expect(existsSync(join(dir, "t.js"))).toBe(true);
	});

	test("the refusal resets on the next turn", async () => {
		const dir = tempDir("placeholder-");
		const ex = new ToolExecutor(dir);
		ex.beginTurn("x");
		await ex.execute("write_file", { path: "U.md", content: doc });
		await ex.execute("write_file", { path: "U.md", content: doc });
		ex.beginTurn("y");
		const out = await ex.execute("write_file", { path: "U.md", content: doc + "more\n" });
		expect(out.startsWith("Error:")).toBe(true);
		expect(readFileSync(join(dir, "U.md"), "utf-8")).toBe(doc);
	});

	test("edit_file is refused once, file untouched, then accepted", async () => {
		const dir = tempDir("placeholder-");
		const ex = new ToolExecutor(dir);
		ex.beginTurn("x");
		await ex.execute("write_file", { path: "U.md", content: "Go to FOLDER.\n" });
		const edit = { path: "U.md", oldText: "FOLDER", newText: "/path/to/Tally" };
		const first = await ex.execute("edit_file", edit);
		expect(first.startsWith("Error:")).toBe(true);
		expect(readFileSync(join(dir, "U.md"), "utf-8")).toBe("Go to FOLDER.\n");
		expect(await ex.execute("edit_file", edit)).toContain("File edited");
		expect(readFileSync(join(dir, "U.md"), "utf-8")).toBe("Go to /path/to/Tally.\n");
	});
});
