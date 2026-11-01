/**
 * A cd-prefixed command keeps its folder on a cut card (#4178).
 *
 * The one-line card cuts a long target at its end (wrap="truncate-end"). The
 * card text comes from commandInFolder, so it must put the folder first or the
 * person approving `cd video && magick ...` sees only `magick ...`. Rendered
 * through Ink at a real width, the way the approval card reaches the screen.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { type Instance, render } from "ink";
import React from "react";
import { commandInFolder } from "../../../../../packages/permissions/cd-prefix.js";
import { InlineApprovalPrompt } from "../InlineApprovalPrompt.js";

type FakeStdout = Writable & { columns: number; rows: number; last: string };

function makeStdout(columns: number): FakeStdout {
	const out = new Writable({
		write(chunk, _enc, cb) {
			const s = chunk.toString();
			if (s.trim()) out.last = s;
			cb();
		},
	}) as FakeStdout;
	out.last = "";
	out.columns = columns;
	out.rows = 30;
	return out;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
const stripAnsi = (s: string) => s.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "");
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/** The magick line from the 2026-10-13 media-brief-video run, padded past any card width. */
const LONG = `magick -size 1280x720 xc:'#0f2b3d' \\( -background none -fill white -font Helvetica -pointsize 44 -size 1100x caption:@t2.txt \\) -gravity center -composite slide2.png ${"-quality 92 ".repeat(20)}`;

let instance: Instance | null = null;
afterEach(() => {
	instance?.unmount();
	instance = null;
});

async function cardLine(target: string, columns: number): Promise<string> {
	const stdout = makeStdout(columns);
	instance = render(<InlineApprovalPrompt target={target} />, {
		stdout: stdout as unknown as NodeJS.WriteStream,
		patchConsole: false,
		exitOnCtrlC: false,
	});
	for (let i = 0; i < 100 && !stdout.last.includes("ASK"); i++) await tick(10);
	const line = stripAnsi(stdout.last)
		.split("\n")
		.find((l) => l.includes("ASK"));
	return line ?? "";
}

describe("cut approval card keeps the cd folder (#4178)", () => {
	test("a 300-character command in the cd form keeps `cd video &&` on an 80-column card", async () => {
		expect(LONG.length).toBeGreaterThan(300);
		expect(LONG).not.toContain("video");
		const line = await cardLine(commandInFolder(LONG, "video"), 80);
		expect(line).toContain("ASK cd video && magick");
		expect(line).toContain("…");
	});

	test("a nested folder leads a cut card at 100 columns", async () => {
		const line = await cardLine(commandInFolder(LONG, "assets/slides"), 100);
		expect(line).toContain("ASK cd assets/slides && magick");
		expect(line).toContain("…");
	});
});
