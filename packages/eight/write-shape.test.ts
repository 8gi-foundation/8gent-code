/**
 * #3580: in pilot run 2026-10-06_184507/media-brief-video the model was asked
 * for "5 slides separated by ---" and "exactly one line of narration per
 * slide". It wrote 6 of each, then marked its plan step "5 slides" done,
 * because the write result only said "File written". write_file now reports
 * the shape of a text file it wrote, on both tool paths, so the real count is
 * in front of the model on the next step.
 */

import { afterAll, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { agentTools, getToolContext, setToolContext } from "../ai/tools";
import { writeShapeLine } from "../ai/write-shape";
import { ToolExecutor } from "./tools";

afterAll(cleanupTempDirs);

// The slides.md the model wrote in that run: title, 4 points, and a closer.
const SIX_SLIDES = [
	"# Tide Library",
	"",
	"A tool-lending library for everyone on Harbour Street.",
	"---",
	"# 1. What it is",
	"",
	"Drills, ladders, sewing machines and garden tools.",
	"---",
	"# 2. How to borrow",
	"",
	"Get a free membership card at the desk.",
	"---",
	"# 3. When we are open",
	"",
	"Saturdays from 10 to 2.",
	"---",
	"# 4. How to help",
	"",
	"We need volunteers.",
	"---",
	"# Borrow it, don't buy it.",
	"",
].join("\n");

const NARRATION_SIX = "One.\nTwo.\nThree.\nFour.\nFive.\nSix.\n";

describe("writeShapeLine", () => {
	test("the failing run's slides.md reports 6 sections, not the 5 the model claimed", () => {
		expect(writeShapeLine("video/slides.md", SIX_SLIDES)).toBe(
			"Shape: 16 non-empty lines; 6 sections separated by ---. If the request named a count, check it matches before moving on.",
		);
	});

	test("the narration file reports its non-empty line count", () => {
		expect(writeShapeLine("video/narration.txt", NARRATION_SIX)).toStartWith(
			"Shape: 6 non-empty lines.",
		);
		expect(writeShapeLine("n.txt", "One line\n\n\n")).toStartWith("Shape: 1 non-empty line.");
	});

	test("Marp front matter is not a section, and empty trailing sections are not counted", () => {
		const deck = "---\nmarp: true\ntheme: default\n---\n\n# A\n---\n# B\n---\n\n";
		expect(writeShapeLine("deck.md", deck)).toContain("; 2 sections separated by ---.");
	});

	test("a leading --- before prose is a separator, not front matter", () => {
		expect(writeShapeLine("s.md", "---\n# A\n---\n# B\n")).toContain(
			"; 2 sections separated by ---.",
		);
	});

	test("prose without separators reports lines only", () => {
		expect(writeShapeLine("notes.md", "# Notes\nOne\n")).toBe(
			"Shape: 2 non-empty lines. If the request named a count, check it matches before moving on.",
		);
	});

	test("code and config files get no shape line", () => {
		for (const p of ["src/a.ts", "package.json", "index.html", "Makefile", "a.yaml"]) {
			expect(writeShapeLine(p, "---\nx\n---\ny\n")).toBe("");
		}
	});
});

describe("write_file reports the shape on both tool paths", () => {
	test("ToolExecutor (text-tool and local providers)", async () => {
		const dir = tempDir("write-shape-");
		const out = await new ToolExecutor(dir).execute("write_file", {
			path: "video/slides.md",
			content: SIX_SLIDES,
		});
		expect(out).toStartWith(`File written: ${path.join(dir, "video/slides.md")}`);
		expect(out).toContain("\nShape: 16 non-empty lines; 6 sections separated by ---.");
	});

	test("AI SDK registry", async () => {
		const dir = tempDir("write-shape-");
		const before = getToolContext();
		setToolContext({ ...before, workingDirectory: dir });
		try {
			const out = await agentTools.write_file.execute?.(
				{ path: "video/narration.txt", content: NARRATION_SIX },
				{ toolCallId: "t", messages: [] },
			);
			expect(out).toStartWith(`File written: ${path.join(dir, "video/narration.txt")}`);
			expect(out).toContain("\nShape: 6 non-empty lines.");
		} finally {
			setToolContext(before);
		}
	});

	test("a source file's result is unchanged", async () => {
		const dir = tempDir("write-shape-");
		const out = await new ToolExecutor(dir).execute("write_file", {
			path: "src/x.ts",
			content: "export const x = 1;\n",
		});
		expect(out).toBe(`File written: ${path.join(dir, "src/x.ts")}`);
	});
});
