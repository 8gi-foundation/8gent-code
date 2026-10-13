/**
 * #3580: in pilot run 2026-10-06_184507/media-brief-video the model was asked
 * for "5 slides separated by ---" and "exactly one line of narration per
 * slide". It wrote 6 of each, then marked its plan step "5 slides" done,
 * because the write result only said "File written". write_file now reports
 * the shape of a text file it wrote, on both tool paths, so the real count is
 * in front of the model on the next step.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { withImagesWritten } from "../ai/image-shape";
import {
	briefPoints,
	describeGaps,
	forgetWrittenNarrations,
	narrationGaps,
	renderCoverageRefusal,
	renderedCoverageLine,
	simpleCommands,
	slidePoints,
} from "../ai/narration-coverage";
import { agentTools, getToolContext, setToolContext } from "../ai/tools";
import { writeShapeLine } from "../ai/write-shape";
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
const BUILD_SH =
	"#!/bin/sh\nset -e\ncd video\nffmpeg -y -f concat -safe 0 -i list.txt -c copy brief.mp4\n";

/** work/brief.md, work/video/{slides.md,narration.txt,build.sh}: the run's layout. */
function videoDir(narration: string): string {
	const dir = tempDir("narration-");
	fs.mkdirSync(path.join(dir, "video"));
	fs.writeFileSync(path.join(dir, "brief.md"), BRIEF);
	fs.writeFileSync(path.join(dir, "video/slides.md"), RUN_SLIDES);
	fs.writeFileSync(path.join(dir, "video/narration.txt"), narration);
	fs.writeFileSync(path.join(dir, "video/build.sh"), BUILD_SH);
	return dir;
}

function withEnv(value: string, body: () => void): void {
	const before = process.env.EIGHT_NARRATION_CHECK;
	process.env.EIGHT_NARRATION_CHECK = value;
	try {
		body();
	} finally {
		if (before === undefined) Reflect.deleteProperty(process.env, "EIGHT_NARRATION_CHECK");
		else process.env.EIGHT_NARRATION_CHECK = before;
	}
}

describe("the narration carries every brief point (#4154)", () => {
	const points = briefPoints(BRIEF);
	beforeEach(forgetWrittenNarrations);
	afterAll(forgetWrittenNarrations);

	test("the brief's four numbered points and its close line are the points", () => {
		expect(points.map((p) => p.label)).toEqual([
			"What it is",
			"How to borrow",
			"When we are open",
			"How to help",
			"Close on",
		]);
		expect(points[3].text).toStartWith("We need volunteers");
		expect(points[4].text).toBe("Borrow it, don't buy it.");
	});

	test("positive arm: every point carried, no gap and no warning", () => {
		expect(narrationGaps(points, FIXED_NARRATION)).toEqual([]);
	});

	test("negative arm (a): segment deleted, the check names the point", () => {
		const gaps = narrationGaps(points, SEGMENT_DELETED).filter((g) => g.missing.length > 0);
		expect(gaps.map((g) => g.label)).toEqual(["How to help"]);
		expect(gaps[0].missing).toEqual(["volunteers"]);
		expect(describeGaps(gaps)).toBe(
			"the narration has no segment for: How to help (missing: volunteers)",
		);
	});

	test("negative arm (b): paraphrased without the key term, the check names the point and that term", () => {
		const gaps = narrationGaps(points, PARAPHRASED);
		expect(gaps).toEqual([{ label: "How to help", missing: ["volunteers"], alsoUnsaid: [] }]);
		expect(describeGaps(gaps)).toBe(
			"the narration has no segment for: How to help (missing: volunteers)",
		);
		expect(describeGaps(gaps)).not.toMatch(/\d+ of \d+/);
	});

	test("only nouns of the label and call to action refuse; other unsaid terms only warn", () => {
		const help = narrationGaps([points[3]], "");
		expect(help[0].missing).toEqual(["volunteers", "tools"]);
		expect(help[0].alsoUnsaid).toEqual(["check", "repair", "saturday", "month", "enough"]);
		// "for one week" is in point 2's second sentence: a warning, not a refusal.
		const noWeek = FIXED_NARRATION.replace(" for a week", "");
		expect(narrationGaps(points, noWeek)).toEqual([
			{ label: "How to borrow", missing: [], alsoUnsaid: ["week"] },
		]);
		const dir = videoDir(noWeek);
		const line = writeShapeLine(path.join(dir, "video/narration.txt"), noWeek);
		expect(line).toContain(
			"\nCoverage warning: the narration never says these words from brief.md: How to borrow (week).",
		);
		expect(line).not.toContain("no segment");
		expect(renderCoverageRefusal("bash video/build.sh", dir)).toBeNull();
	});

	test("with no brief, the slides are the points (headings are labels)", () => {
		const gaps = narrationGaps(slidePoints(RUN_SLIDES), PARAPHRASED).filter(
			(g) => g.missing.length > 0,
		);
		expect(gaps).toEqual([{ label: "How to help", missing: ["volunteers"], alsoUnsaid: [] }]);
	});

	test("writing the narration names the missing point; a full one adds nothing", () => {
		const bad = videoDir(PARAPHRASED);
		expect(writeShapeLine(path.join(bad, "video/narration.txt"), PARAPHRASED)).toContain(
			"\nCoverage against brief.md: the narration has no segment for: How to help (missing: volunteers).",
		);
		const good = videoDir(FIXED_NARRATION);
		expect(writeShapeLine(path.join(good, "video/narration.txt"), FIXED_NARRATION)).not.toContain(
			"Coverage",
		);
	});

	test("a render into the narration's folder is refused naming the point, until it is carried", () => {
		const dir = videoDir(PARAPHRASED);
		const refusal = renderCoverageRefusal(
			"ffmpeg -y -f concat -i video/list.txt -c copy video/brief.mp4",
			dir,
		);
		expect(refusal).toStartWith(
			"[RENDER CHECK] Render refused: the narration has no segment for: How to help (missing: volunteers).",
		);
		expect(refusal).toContain("EIGHT_NARRATION_CHECK=0");
		// The run's own `bash video/build.sh` (cd video, then ffmpeg on its own line), and `cd video && ffmpeg`.
		expect(renderCoverageRefusal("bash video/build.sh", dir)).toContain(
			"How to help (missing: volunteers)",
		);
		expect(renderCoverageRefusal("cd video && ffmpeg -y -i a.png out.mp4", dir)).toContain(
			"How to help",
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
		// Positive arm: the render goes ahead.
		fs.writeFileSync(path.join(dir, "video/narration.txt"), FIXED_NARRATION);
		expect(renderCoverageRefusal("bash video/build.sh", dir)).toBeNull();
		expect(preSpawnRefusal("bash video/build.sh", dir)).toBeNull();
	});

	test("not refused: ffmpeg named anywhere but as the executable of a video render", () => {
		const dir = videoDir(PARAPHRASED);
		writeShapeLine(path.join(dir, "video/narration.txt"), PARAPHRASED); // written this process
		for (const cmd of [
			"ffmpeg -version",
			"which ffmpeg",
			"brew install ffmpeg",
			"grep -rn ffmpeg src",
			"echo ffmpeg",
			"git commit -m 'drop ffmpeg dep'",
			'git commit -m "fix ffmpeg render of video/brief.mp4"',
			"gh issue create --title 'ffmpeg crash; video/brief.mp4'",
			"cat video/narration.txt",
			"ffprobe -v error video/brief.mp4",
		]) {
			expect([cmd, renderCoverageRefusal(cmd, dir)]).toEqual([cmd, null]);
			expect([cmd, preSpawnRefusal(cmd, dir)]).toEqual([cmd, null]);
		}
	});

	test("not refused: an unrelated ffmpeg run next to a narration it does not write into", () => {
		const dir = videoDir(PARAPHRASED); // narration NOT written this session
		for (const cmd of [
			"ffmpeg -i ~/Downloads/clip.mov out.gif",
			"ffmpeg -i ~/Downloads/clip.mov out.mp4",
			`ffmpeg -i video/brief.mp4 ${path.join(tempDir("elsewhere-"), "copy.mp4")}`,
		]) {
			expect([cmd, renderCoverageRefusal(cmd, dir)]).toEqual([cmd, null]);
		}
	});

	test("not refused: the ~/podcast case (a to-do list brief and a script.txt)", () => {
		const home = tempDir("podcast-home-");
		fs.writeFileSync(
			path.join(home, "brief.md"),
			"1. Shopping. milk, eggs\n2. Calls. call the plumber\n",
		);
		fs.mkdirSync(path.join(home, "podcast"));
		fs.writeFileSync(path.join(home, "podcast/script.txt"), "Welcome to episode one.\n");
		const podcast = path.join(home, "podcast");
		expect(renderCoverageRefusal("ffmpeg -i ep1.wav ep1.mp3", podcast)).toBeNull();
		expect(renderCoverageRefusal("ffmpeg -i ep1.wav ep1.mp4", podcast)).toBeNull();
		expect(
			writeShapeLine(path.join(podcast, "script.txt"), "Welcome to episode one.\n"),
		).not.toContain("Coverage");
	});

	test("scripts: only an ffmpeg executable line counts; comments and FIFOs do not", () => {
		const dir = videoDir(PARAPHRASED);
		fs.writeFileSync(
			path.join(dir, "video/build.sh"),
			"#!/bin/sh\ncd video\n# ffmpeg -i a.png brief.mp4\necho ffmpeg\n",
		);
		expect(renderCoverageRefusal("bash video/build.sh", dir)).toBeNull();
		fs.writeFileSync(
			path.join(dir, "video/build.sh"),
			"cd video\nfor i in 1 2; do ffmpeg -y -i s$i.png \\\n  c$i.mp4; done\n",
		);
		expect(renderCoverageRefusal("sh video/build.sh", dir)).toContain("How to help");
		const fifo = path.join(dir, "video/pipe.sh");
		expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
		expect(renderCoverageRefusal("bash video/pipe.sh", dir)).toBeNull();
	});

	test("a written narration binds renders from its project root or inside it, not from a parent", () => {
		const dir = videoDir(PARAPHRASED);
		const out = path.join(tempDir("out-"), "final.mp4");
		expect(renderCoverageRefusal(`ffmpeg -i video/brief.mp4 ${out}`, dir)).toBeNull();
		writeShapeLine(path.join(dir, "video/narration.txt"), PARAPHRASED);
		expect(renderCoverageRefusal(`ffmpeg -i video/brief.mp4 ${out}`, dir)).toContain("How to help");
		expect(renderCoverageRefusal(`ffmpeg -i brief.mp4 ${out}`, path.join(dir, "video"))).toContain(
			"How to help",
		);
		// A parent of that working directory is not inside it.
		expect(renderCoverageRefusal(`ffmpeg -i x.mov ${out}`, path.dirname(dir))).toBeNull();
	});

	test("another session's narration does not refuse and is never named (one process, many sessions)", async () => {
		// Session A writes a narration with a gap and renders beside it.
		const a = videoDir(PARAPHRASED);
		writeShapeLine(path.join(a, "video/narration.txt"), PARAPHRASED);
		const since = Date.now() - 1000;
		fs.writeFileSync(path.join(a, "video/brief.mp4"), "x");
		expect(renderCoverageRefusal("bash video/build.sh", a)).toContain("How to help");
		// Session B, another project in the same process: an unrelated render.
		const b = tempDir("project-b-");
		fs.writeFileSync(path.join(b, "out.mp4"), "x");
		expect(renderCoverageRefusal("ffmpeg -i ~/Downloads/clip.mov out.mp4", b)).toBeNull();
		expect(preSpawnRefusal("ffmpeg -i ~/Downloads/clip.mov out.mp4", b)).toBeNull();
		const resultB = await withImagesWritten("done", b, since);
		expect(resultB).toBe("done");
		expect(resultB).not.toContain(a);
		expect(renderedCoverageLine(b, 0)).toBe("");
		// A still sees its own.
		expect(renderedCoverageLine(a, since)).toContain("How to help (missing: volunteers)");
	});

	test("a compound said as two words counts (boat house, boathouse)", () => {
		const spaced = FIXED_NARRATION.replace("boathouse", "boat house");
		expect(narrationGaps(points, spaced)).toEqual([]);
	});

	test("after render: a video beside a narration written this session is named in the command result", async () => {
		const dir = videoDir(PARAPHRASED);
		const since = Date.now() - 1000;
		fs.writeFileSync(path.join(dir, "video/brief.mp4"), "not really a video");
		// Not written this session: nothing scanned.
		expect(await withImagesWritten("done", dir, since)).toBe("done");
		writeShapeLine(path.join(dir, "video/narration.txt"), PARAPHRASED);
		const out = await withImagesWritten("done", dir, since);
		expect(out).toContain("Render check:");
		expect(out).toContain("the narration has no segment for: How to help (missing: volunteers)");
		fs.writeFileSync(path.join(dir, "video/narration.txt"), FIXED_NARRATION);
		expect(await withImagesWritten("done", dir, since)).toBe("done");
		expect(renderedCoverageLine(dir, Date.now() + 60_000)).toBe("");
	});

	test("EIGHT_NARRATION_CHECK=0, false or off turns every part off", () => {
		const dir = videoDir(PARAPHRASED);
		for (const v of ["0", "false", "off", "OFF"]) {
			withEnv(v, () => {
				expect(renderCoverageRefusal("bash video/build.sh", dir)).toBeNull();
				expect(writeShapeLine(path.join(dir, "video/narration.txt"), PARAPHRASED)).not.toContain(
					"Coverage",
				);
				expect(renderedCoverageLine(dir, 0)).toBe("");
			});
		}
	});

	test("simple commands keep quoted separators inside their word", () => {
		expect(simpleCommands(`git commit -m "a; ffmpeg x" && ffmpeg -i a b.mp4 # ffmpeg c`)).toEqual([
			["git", "commit", "-m", "a; ffmpeg x"],
			["ffmpeg", "-i", "a", "b.mp4"],
		]);
	});

	test("write_file shows the missing point on both tool paths", async () => {
		const dir = videoDir("");
		const text = await new ToolExecutor(dir).execute("write_file", {
			path: "video/narration.txt",
			content: PARAPHRASED,
		});
		expect(text).toContain("the narration has no segment for: How to help (missing: volunteers)");
		// ToolExecutor recorded it under its working directory: a render to elsewhere is bound.
		const elsewhere = path.join(tempDir("out-"), "final.mp4");
		expect(renderCoverageRefusal(`ffmpeg -i a.mov ${elsewhere}`, dir)).toContain("How to help");
		forgetWrittenNarrations();
		expect(renderCoverageRefusal(`ffmpeg -i a.mov ${elsewhere}`, dir)).toBeNull();
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
			// The native path recorded it under the tool context's working directory too.
			expect(renderCoverageRefusal(`ffmpeg -i a.mov ${elsewhere}`, dir)).toContain("How to help");
		} finally {
			setToolContext(before);
		}
	});
});
