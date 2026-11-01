/**
 * `8gent deck render <spec.json> [out.mp4]` is the shell door to render_video_deck:
 * the same renderer and the same confinement as the tool. The pilot
 * media-brief-video (12 Oct 2026) showed a local model hand-rolling ffmpeg in
 * run_command instead of calling the tool, so the renderer must be one line of
 * shell away and every guard must hold on that path too.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import type { RenderDeckOptions, RenderDeckResult } from "../tools/video-deck";
import { DECK_USAGE, runDeckCommand } from "./deck-cli";

afterAll(cleanupTempDirs);

const hasFfmpeg =
	spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;
const BIN = resolve(import.meta.dir, "..", "..", "bin", "8gent.ts");

const SPEC = {
	title: "Tide Library",
	slides: [
		{ title: "Tide Library", text: "A tool-lending library on Harbour Street.", seconds: 1 },
		{
			title: "How to borrow",
			bullets: ["Free card at the desk", "Three items for one week"],
			seconds: 1,
		},
	],
};

let ws: string;
let outside: string;
let lines: string[];
let errors: string[];

/** A render seam that must never be reached: the guards run before it. */
const neverRender = async (_: RenderDeckOptions): Promise<RenderDeckResult> => {
	throw new Error("render was reached: a guard did not hold");
};

beforeEach(() => {
	ws = realpathSync(tempDir("deck-cli-ws-"));
	outside = realpathSync(tempDir("deck-cli-out-"));
	writeFileSync(join(ws, "deck.json"), JSON.stringify(SPEC));
	writeFileSync(join(outside, "deck.json"), JSON.stringify(SPEC));
	symlinkSync(join(outside, "deck.json"), join(ws, "linked.json"));
	symlinkSync(outside, join(ws, "escape"));
	lines = [];
	errors = [];
});

const run = (args: string[], render?: typeof neverRender) =>
	runDeckCommand(args, {
		cwd: ws,
		log: (l) => lines.push(l),
		error: (l) => errors.push(l),
		render,
	});

describe("8gent deck render", () => {
	test("renders a 2-slide spec into an mp4 inside the working directory", async () => {
		if (!hasFfmpeg) return;
		const code = await run(["render", "deck.json", "video/brief.mp4"]);
		expect(errors).toEqual([]);
		expect(code).toBe(0);
		const result = JSON.parse(lines[0]) as RenderDeckResult;
		expect(result.slides).toBe(2);
		expect(result.width).toBe(1280);
		expect(result.durationSec).toBeGreaterThan(1.5);
		expect(result.path).toBe("video/brief.mp4");
		expect(existsSync(join(ws, "video", "brief.mp4"))).toBe(true);
		// Scratch frames are gone; nothing landed outside video/.
		expect(readdirSync(join(ws, ".tmp"))).toEqual([]);
	}, 120_000);

	test("the same render function as the tool, with the same options", async () => {
		const seen: RenderDeckOptions[] = [];
		const code = await run(["render", "deck.json"], async (o) => {
			seen.push(o);
			return {
				path: o.out,
				durationSec: 2,
				videoSec: 2,
				audioSec: null,
				slides: 2,
				width: 1280,
				height: 720,
				hasAudio: false,
				kind: "video",
				starts: [0, 1],
				chapters: ["0:00 One", "0:01 Two"],
				chaptersPath: "video/chapters.txt",
				durationLabel: "0:02",
			};
		});
		expect(code).toBe(0);
		expect(seen).toHaveLength(1);
		expect(seen[0].cwd).toBe(ws);
		expect(seen[0].out).toBe(join(ws, "deck.mp4"));
		expect(seen[0].spec).toEqual(SPEC);
	});

	test("usage for anything but `render <spec>` with at most one out", async () => {
		for (const args of [
			[],
			["render"],
			["list", "deck.json"],
			["render", "deck.json", "a.mp4", "extra"],
			["render", "--help"],
		]) {
			lines = [];
			expect(await run(args, neverRender), args.join(" ")).toBe(2);
			expect(lines[0]).toBe(DECK_USAGE);
		}
	});
});

describe("the tool's guards hold on the CLI path", () => {
	test("a spec outside the working directory, or reached through a link, is refused before the render", async () => {
		for (const spec of [
			"../deck.json",
			join(outside, "deck.json"),
			"linked.json",
			"escape/deck.json",
			"~/deck.json",
		]) {
			errors = [];
			expect(await run(["render", spec], neverRender), spec).toBe(1);
			expect(errors[0], spec).toMatch(/traversal|outside|blocked/i);
		}
	});

	test("an output outside the working directory, through a link, or not an mp4 is refused before the render", async () => {
		for (const out of [
			"../x.mp4",
			join(outside, "x.mp4"),
			"escape/x.mp4",
			"deck.mov",
			"linked.json",
		]) {
			errors = [];
			expect(await run(["render", "deck.json", out], neverRender), out).toBe(1);
			expect(errors[0], out).toMatch(/traversal|outside|blocked|must end in \.mp4/i);
		}
	});

	test("a spec that is not .json, not a file, or not JSON is refused before the render", async () => {
		writeFileSync(join(ws, "deck.txt"), "{}");
		writeFileSync(join(ws, "bad.json"), "{nope");
		mkdirSync(join(ws, "dir.json"));
		for (const [spec, why] of [
			["deck.txt", /\.json/],
			["missing.json", /ENOENT|no such file|not found/i],
			["bad.json", /not valid JSON/],
			["dir.json", /not a file|EISDIR/i],
		] as const) {
			errors = [];
			expect(await run(["render", spec], neverRender), spec).toBe(1);
			expect(errors[0], spec).toMatch(why);
		}
	});

	test("an invalid deck spec is refused by the renderer's schema and nothing is written", async () => {
		writeFileSync(join(ws, "empty.json"), JSON.stringify({ slides: [] }));
		expect(await run(["render", "empty.json", "out.mp4"])).toBe(1);
		expect(errors[0]).toMatch(/invalid deck spec/);
		expect(existsSync(join(ws, "out.mp4"))).toBe(false);
	});
});

describe("through bin/8gent.ts", () => {
	const cli = (args: string[], env: Record<string, string> = {}) =>
		spawnSync("bun", [BIN, "deck", ...args], {
			cwd: ws,
			encoding: "utf8",
			timeout: 60_000,
			env: { ...process.env, ...env, EIGHT_SYSTEM_ONE: "0" },
		});

	test("the cwd escape is refused at the real entry point", () => {
		const r = cli(["render", "../deck.json"]);
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(/traversal|outside|blocked/i);
		expect(r.stdout).not.toContain("durationSec");
	});

	test("usage exits 2, and the command is exempt from the sub-8gent depth refusal (it starts no model loop)", () => {
		const r = cli([], { EIGHT_AGENT_DEPTH: "4" });
		expect(r.status).toBe(2);
		expect(r.stdout).toContain("Usage: 8gent deck render");
		expect(r.stderr).not.toMatch(/depth/i);
	});
});
