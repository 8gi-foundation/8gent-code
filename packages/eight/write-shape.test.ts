/**
 * #3580: in pilot run 2026-10-06_184507/media-brief-video the model was asked
 * for "5 slides separated by ---" and "exactly one line of narration per
 * slide". It wrote 6 of each, then marked its plan step "5 slides" done,
 * because the write result only said "File written". write_file now reports
 * the shape of a text file it wrote, on both tool paths, so the real count is
 * in front of the model on the next step.
 */

import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { agentTools, getToolContext, setToolContext } from "../ai/tools";
import { withImagesWritten } from "../ai/image-shape";
import {
	briefPoints,
	describeGaps,
	narrationGaps,
	renderCoverageRefusal,
	renderedCoverageLine,
	slidePoints,
	writeShapeLine,
} from "../ai/write-shape";
import { preSpawnRefusal } from "../permissions/pre-spawn-backstops";
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

	test("front matter with a block value or a list is still front matter", () => {
		const style = "---\nmarp: true\nstyle: |\n  section { color: red }\n---\n# A\n---\n# B\n";
		expect(writeShapeLine("deck.md", style)).toContain("; 2 sections separated by ---.");
		const list = "---\nmarp: true\nheaderTags:\n  - a\n---\n# A\n---\n# B\n";
		expect(writeShapeLine("deck.md", list)).toContain("; 2 sections separated by ---.");
	});

	test("--- inside fenced code is not a separator", () => {
		expect(writeShapeLine("a.md", "# A\n```yaml\n---\nk: v\n---\n```\n")).toBe(
			"Shape: 6 non-empty lines. If the request named a count, check it matches before moving on.",
		);
		expect(writeShapeLine("a.md", "# A\n~~~\n---\n~~~\n---\n# B\n")).toContain(
			"; 2 sections separated by ---.",
		);
	});

	test("text then --- is a separator, as the user means it (the pilot's file)", () => {
		expect(writeShapeLine("s.md", "Body one.\n---\nBody two.\n")).toContain(
			"; 2 sections separated by ---.",
		);
	});

	test("CRLF and a BOM are handled; front matter is out of both counts", () => {
		expect(writeShapeLine("s.md", "﻿---\r\nmarp: true\r\n---\r\n# A\r\n---\r\n# B\r\n")).toBe(
			"Shape: 3 non-empty lines; 2 sections separated by ---. If the request named a count, check it matches before moving on.",
		);
	});

	test("an empty write, or front matter only, gets no shape line", () => {
		expect(writeShapeLine("e.txt", "")).toBe("");
		expect(writeShapeLine("e.md", "\n\n")).toBe("");
		expect(writeShapeLine("deck.md", "---\nmarp: true\n---\n")).toBe("");
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

/*
 * #4154: pilot run 2026-10-13_034421/media-brief-video. Brief point 4 read
 * "How to help. We need volunteers to check and repair returned tools."; the
 * narration paraphrased it as "Help us by checking and repairing returned
 * tools" and the video rendered without the volunteers point. BRIEF, RUN_SLIDES
 * and RUN_NARRATION are the files from that run, verbatim.
 */
const BRIEF = [
	"# Brief: Tide Library launch video",
	"",
	"Audience: people living around Harbour Street. Tone: warm, plain, short.",
	"",
	"1. What it is. Tide Library is a tool-lending library: drills, ladders, sewing machines and garden tools, free to anyone who lives nearby.",
	"2. How to borrow. Get a free membership card at the desk by showing proof of address. Each card borrows up to three items for one week.",
	"3. When we are open. Saturdays from 10 to 2, and Wednesday evenings from 6 to 8, in the old boathouse on Harbour Street.",
	"4. How to help. We need volunteers to check and repair returned tools. One Saturday a month is enough.",
	"",
	'Close on: "Borrow it, don\'t buy it."',
	"",
].join("\n");

const RUN_SLIDES = [
	"# Tide Library",
	"",
	"A tool-lending library on Harbour Street",
	"",
	"---",
	"",
	"## What it is",
	"",
	"Tide Library lends drills, ladders, sewing machines and garden tools, free to anyone who lives nearby.",
	"",
	"---",
	"",
	"## How to borrow",
	"",
	"Get a free membership card at the desk with proof of address. Each card borrows up to three items for one week.",
	"",
	"---",
	"",
	"## When we are open",
	"",
	"Saturdays from 10 to 2, and Wednesday evenings from 6 to 8, in the old boathouse on Harbour Street.",
	"",
	"---",
	"",
	"## How to help",
	"",
	"We need volunteers to check and repair returned tools. One Saturday a month is enough.",
	"",
	"Borrow it, don't buy it.",
	"",
].join("\n");

const RUN_NARRATION = [
	"Tide Library, a new tool-lending library on Harbour Street.",
	"We lend drills, ladders, sewing machines and garden tools, free to anyone who lives nearby.",
	"Get a free card at the desk with proof of address, and borrow up to three items for a week.",
	"We are open Saturdays from ten to two, and Wednesday evenings from six to eight, in the old boathouse on Harbour Street.",
	"Help us by checking and repairing returned tools. One Saturday a month is enough. Borrow it, don't buy it.",
	"",
].join("\n");

// The positive arm: the run's own narration with the call to action naming what is needed.
const FIXED_NARRATION = RUN_NARRATION.replace(
	"Help us by checking",
	"We need volunteers for checking",
);
// Negative arm (a): the segment for point 4 deleted outright.
const SEGMENT_DELETED = RUN_NARRATION.split("\n")
	.filter((l) => !l.startsWith("Help us"))
	.join("\n");
// Negative arm (b): the run's narration as written, a paraphrase without the key term.
const PARAPHRASED = RUN_NARRATION;

function videoDir(narration: string, extra: Record<string, string> = {}): string {
	const dir = tempDir("narration-");
	fs.mkdirSync(path.join(dir, "video"));
	fs.writeFileSync(path.join(dir, "brief.md"), BRIEF);
	fs.writeFileSync(path.join(dir, "video/slides.md"), RUN_SLIDES);
	fs.writeFileSync(path.join(dir, "video/narration.txt"), narration);
	for (const [name, body] of Object.entries(extra)) fs.writeFileSync(path.join(dir, name), body);
	return dir;
}

describe("the narration carries every brief point (#4154)", () => {
	const points = briefPoints(BRIEF);

	test("the brief's points are enumerated with their labels, the close line is not a point", () => {
		expect(points.map((p) => p.label)).toEqual([
			"What it is",
			"How to borrow",
			"When we are open",
			"How to help",
		]);
		expect(points[3].text).toStartWith("We need volunteers");
	});

	test("positive arm: every point carried, no gap", () => {
		expect(narrationGaps(points, FIXED_NARRATION)).toEqual([]);
	});

	test("negative arm (a): segment deleted, the check names the point and its terms", () => {
		const gaps = narrationGaps(points, SEGMENT_DELETED);
		expect(gaps.map((g) => g.label)).toEqual(["How to help"]);
		expect(gaps[0].missing).toContain("volunteers");
		expect(gaps[0].missing).toContain("repair");
		expect(describeGaps(gaps)).toStartWith(
			"the narration has no segment for: How to help (missing: volunteers",
		);
	});

	test("negative arm (b): paraphrased without the key term, the check names the point and that term only", () => {
		const gaps = narrationGaps(points, PARAPHRASED);
		expect(gaps).toEqual([{ label: "How to help", missing: ["volunteers"] }]);
		expect(describeGaps(gaps)).toBe(
			"the narration has no segment for: How to help (missing: volunteers)",
		);
	});

	test("a failure names the point, never a count", () => {
		expect(describeGaps(narrationGaps(points, PARAPHRASED))).not.toMatch(/\d+ of \d+/);
	});

	test("with no brief, the slides are the points (headings are labels)", () => {
		const gaps = narrationGaps(slidePoints(RUN_SLIDES), PARAPHRASED);
		expect(gaps.find((g) => g.label === "How to help")?.missing).toEqual(["volunteers"]);
		expect(
			narrationGaps(
				slidePoints(RUN_SLIDES),
				FIXED_NARRATION.replace("free card", "free membership card"),
			),
		).toEqual([]);
	});

	test("writing the narration names the missing point; a full one adds nothing", () => {
		const bad = videoDir(PARAPHRASED);
		const line = writeShapeLine(path.join(bad, "video/narration.txt"), PARAPHRASED);
		expect(line).toContain(
			"\nCoverage against brief.md: the narration has no segment for: How to help (missing: volunteers).",
		);
		const good = videoDir(FIXED_NARRATION);
		expect(writeShapeLine(path.join(good, "video/narration.txt"), FIXED_NARRATION)).not.toContain(
			"Coverage",
		);
	});

	test("a render is refused naming the point until the narration carries it", () => {
		const build =
			"#!/bin/sh\nset -e\ncd video\nffmpeg -y -f concat -i list.txt -c copy brief.mp4\n";
		const dir = videoDir(PARAPHRASED, { "build.sh": build });
		fs.writeFileSync(path.join(dir, "video/build.sh"), build);
		const direct = renderCoverageRefusal(
			"ffmpeg -y -f concat -i video/list.txt -c copy video/brief.mp4",
			dir,
		);
		expect(direct).toStartWith(
			"[BLOCKED] Render refused: the narration has no segment for: How to help (missing: volunteers).",
		);
		// Through a script: the run's own `bash video/build.sh`, and one in cwd that does `cd video`.
		expect(renderCoverageRefusal("bash video/build.sh", dir)).toContain(
			"How to help (missing: volunteers)",
		);
		expect(renderCoverageRefusal("sh build.sh", dir)).toContain(
			"How to help (missing: volunteers)",
		);
		// The shared run_command backstop, used by both tool paths, refuses it too.
		expect(preSpawnRefusal("bash video/build.sh", dir)).toContain(
			"How to help (missing: volunteers)",
		);
		// Negative arm (a) is refused as well.
		fs.writeFileSync(path.join(dir, "video/narration.txt"), SEGMENT_DELETED);
		expect(renderCoverageRefusal("bash video/build.sh", dir)).toContain(
			"no segment for: How to help",
		);
		// Not a render: untouched.
		expect(renderCoverageRefusal("ffprobe -v error video/brief.mp4", dir)).toBeNull();
		expect(preSpawnRefusal("cat video/narration.txt", dir)).toBeNull();
		// Positive arm: the render goes ahead.
		fs.writeFileSync(path.join(dir, "video/narration.txt"), FIXED_NARRATION);
		expect(renderCoverageRefusal("bash video/build.sh", dir)).toBeNull();
		expect(preSpawnRefusal("bash video/build.sh", dir)).toBeNull();
	});

	test("after render: a video written beside a narration missing a point is named in the command result", async () => {
		const dir = videoDir(PARAPHRASED);
		const since = Date.now() - 1000;
		fs.writeFileSync(path.join(dir, "video/brief.mp4"), "not really a video");
		const out = await withImagesWritten("done", dir, since);
		expect(out).toContain("Render check:");
		expect(out).toContain("the narration has no segment for: How to help (missing: volunteers)");
		fs.writeFileSync(path.join(dir, "video/narration.txt"), FIXED_NARRATION);
		expect(await withImagesWritten("done", dir, since)).toBe("done");
		// An older video is not this command's render.
		const old = videoDir(PARAPHRASED);
		fs.writeFileSync(path.join(old, "video/brief.mp4"), "x");
		expect(renderedCoverageLine(old, Date.now() + 60_000)).toBe("");
	});

	test("EIGHT_NARRATION_CHECK=0 turns the check off", () => {
		const dir = videoDir(PARAPHRASED);
		const before = process.env.EIGHT_NARRATION_CHECK;
		process.env.EIGHT_NARRATION_CHECK = "0";
		try {
			expect(renderCoverageRefusal("ffmpeg -i video/a.wav video/b.mp4", dir)).toBeNull();
			expect(writeShapeLine(path.join(dir, "video/narration.txt"), PARAPHRASED)).not.toContain(
				"Coverage",
			);
			expect(renderedCoverageLine(dir, 0)).toBe("");
		} finally {
			if (before === undefined) Reflect.deleteProperty(process.env, "EIGHT_NARRATION_CHECK");
			else process.env.EIGHT_NARRATION_CHECK = before;
		}
	});

	test("write_file shows the missing point on both tool paths", async () => {
		const dir = videoDir("");
		const text = await new ToolExecutor(dir).execute("write_file", {
			path: "video/narration.txt",
			content: PARAPHRASED,
		});
		expect(text).toContain("the narration has no segment for: How to help (missing: volunteers)");
		const before = getToolContext();
		setToolContext({ ...before, workingDirectory: dir });
		try {
			const native = await agentTools.write_file.execute?.(
				{ path: "video/narration.txt", content: PARAPHRASED },
				{ toolCallId: "t", messages: [] },
			);
			expect(native).toContain(
				"the narration has no segment for: How to help (missing: volunteers)",
			);
		} finally {
			setToolContext(before);
		}
	});
});
