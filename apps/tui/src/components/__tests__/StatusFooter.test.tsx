/**
 * The one-row footer (mockup A). It replaced the FM bar, the seven status
 * tiles and the mode strip, and since #3130 the key hints share its row.
 * These tests render the real BottomBar into fake 80x45 and 160x48
 * terminals and check height, content and the rules: nothing wraps, ^Y
 * stays visible, unknown values and quiet states are not shown.
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { render } from "ink";
import { BottomBar } from "../BottomBar.js";
import {
	FOOTER_HINTS,
	FOOTER_SEPARATOR,
	buildFooterSegments,
	fitFooterHints,
	fitFooterSegments,
	fmSegmentWidth,
	segmentWidth,
} from "../StatusFooter.js";

function fakeStdout(cols: number, rows: number) {
	const out = new EventEmitter() as EventEmitter & {
		columns: number;
		rows: number;
		isTTY: boolean;
		frames: string[];
		write: (s: string) => boolean;
	};
	out.columns = cols;
	out.rows = rows;
	out.isTTY = false;
	out.frames = [];
	out.write = (s: string) => {
		out.frames.push(s);
		return true;
	};
	return out;
}

type Props = Parameters<typeof BottomBar>[0];

const base: Props = {
	model: "qwen3.8:27b-mlx",
	ready: 2,
	total: 3,
	tokens: "179K tok",
	branch: "main",
	user: "james",
	permissions: "ask",
	sessionTime: "8m 12s",
	mode: "Planning",
	isProcessing: false,
};

async function frame(cols: number, rows: number, props: Partial<Props> = {}): Promise<string[]> {
	const stdout = fakeStdout(cols, rows);
	const app = render(<BottomBar {...base} {...props} />, {
		stdout: stdout as unknown as NodeJS.WriteStream,
		debug: true,
		patchConsole: false,
		exitOnCtrlC: false,
	});
	await new Promise((r) => setTimeout(r, 30));
	app.unmount();
	const last = stdout.frames.filter((f) => f.includes("8GENT FM")).at(-1) ?? "";
	// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI
	return last.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\n+$/, "").split("\n");
}

describe("BottomBar renders one footer row, hints included (#3130)", () => {
	test("160x48: one row, the status then the hints, nothing wraps", async () => {
		const lines = await frame(160, 48, { ready: 3, total: 3, user: undefined });
		expect(lines.length).toBe(1);
		const row = lines[0] ?? "";
		expect(row.startsWith("● 8GENT FM idle")).toBe(true);
		for (const part of [
			"mode Planning ^Y",
			"model qwen3.8:27b-mlx",
			"tokens 179K tok",
			"branch main",
			"session 8m 12s",
			"^X plan",
			"^O expand",
		]) {
			expect(row).toContain(part);
		}
		// The status comes first, the hints after it.
		expect(row.indexOf("^X plan")).toBeGreaterThan(row.indexOf("session 8m 12s"));
		expect(row.length).toBeLessThanOrEqual(160);
		// The old chrome is gone: no tiles, no chip row, no bordered bar.
		expect(row).not.toContain("╭");
		expect(row).not.toContain("PLANNING");
		expect(row).not.toContain("AGENTS");
	});

	test("80x45: one row that keeps mode, model and tokens", async () => {
		const lines = await frame(80, 45);
		expect(lines.length).toBe(1);
		const row = lines[0] ?? "";
		expect(row).toContain("● 8GENT FM");
		expect(row).toContain("mode Planning ^Y");
		expect(row).toContain("model qwen3.8:27b-mlx");
		expect(row.length).toBeLessThanOrEqual(80);
	});

	test("short terminal: still one row", async () => {
		const lines = await frame(80, 30);
		expect(lines.length).toBe(1);
		expect(lines[0]).toContain("mode Planning ^Y");
	});

	test("every width from 60 to 200 draws one row that fits, hints whole or absent", async () => {
		for (const cols of [60, 72, 80, 100, 120, 140, 160, 200]) {
			const lines = await frame(cols, 48, { ready: 3, total: 3 });
			expect({ cols, rows: lines.length }).toEqual({ cols, rows: 1 });
			const row = lines[0] ?? "";
			expect(row.length).toBeLessThanOrEqual(cols);
			const tail = row.slice(row.lastIndexOf("│") + 1);
			for (const piece of tail.split(/\s{2,}/).filter((p) => p.startsWith("^"))) {
				expect(FOOTER_HINTS as readonly string[]).toContain(piece.trim());
			}
		}
	});

	test("the mode segment follows ^Y", async () => {
		const row = (await frame(160, 48, { mode: "Debugging" }))[0] ?? "";
		expect(row).toContain("mode Debugging ^Y");
	});

	test("agent pulse shows while a turn runs", async () => {
		const row = (await frame(160, 48, { isProcessing: true }))[0] ?? "";
		expect(row.startsWith("● 8GENT FM agent pulse")).toBe(true);
	});

	test("unknown values are not shown", async () => {
		const row = (await frame(160, 48, { model: "—", branch: "—", total: 0, ready: 0 }))[0] ?? "";
		expect(row).not.toContain("model");
		expect(row).not.toContain("branch");
		expect(row).not.toContain("providers");
		expect(row).not.toContain("—");
	});
});

describe("the System One judge is a footer segment, not a chat line (#3090)", () => {
	test("no segment while System One is off", async () => {
		const row = (await frame(160, 48))[0] ?? "";
		expect(row).not.toContain("judge");
	});

	test("loading and failed read as one word after 'judge'", () => {
		for (const judge of ["loading", "failed"] as const) {
			const seg = buildFooterSegments({ mode: "Planning", judge }).find((s) => s.key === "judge");
			expect(seg?.label).toBe("judge");
			expect(seg?.value).toBe(judge);
		}
	});

	test("failed is the look-here colour, like infinite approval", () => {
		const failed = buildFooterSegments({ mode: "Planning", judge: "failed" }).find((s) => s.key === "judge");
		const infinite = buildFooterSegments({ mode: "Planning", permissions: "infinite" }).find(
			(s) => s.key === "approval",
		);
		const loading = buildFooterSegments({ mode: "Planning", judge: "loading" }).find((s) => s.key === "judge");
		expect(failed?.color).toBe(infinite?.color);
		expect(loading?.color).not.toBe(infinite?.color);
	});

	test("80x45: loading and failed survive the squeeze; ready gives way", async () => {
		for (const judge of ["loading", "failed"] as const) {
			const row = (await frame(80, 45, { judge }))[0] ?? "";
			expect(row).toContain(`judge ${judge}`);
			expect(row).toContain("mode Planning ^Y");
			expect(row.length).toBeLessThanOrEqual(80);
		}
		const ready = (await frame(80, 45, { judge: "ready" }))[0] ?? "";
		expect(ready).not.toContain("judge");
		expect(ready).toContain("model qwen3.8:27b-mlx");
	});

	test("'judge ready' is the quiet state and is not shown (#3130)", async () => {
		const row = (await frame(160, 48, { judge: "ready", user: undefined, tokens: "0 tok" }))[0] ?? "";
		expect(row).not.toContain("judge");
		expect(buildFooterSegments({ mode: "Planning", judge: "ready" }).some((s) => s.key === "judge")).toBe(false);
	});
	test("no count yet (audit 2026-09-30, #7): the tokens segment is not shown at all", async () => {
		const row = (await frame(160, 48, { tokens: "" }))[0] ?? "";
		expect(row).not.toContain("tokens");
		expect(row).not.toContain("0 tok");
		expect(row).toContain("model qwen3.8:27b-mlx");
	});
});

describe("footer segments", () => {
	test("the approval mode prints as a word, never as ?", () => {
		const seg = buildFooterSegments({ mode: "Planning", permissions: "infinite" }).find(
			(s) => s.key === "approval",
		);
		expect(seg?.value).toBe("infinite");
	});

	test("infinite approval is kept almost as long as the mode", () => {
		const segs = buildFooterSegments({
			mode: "Planning",
			model: "qwen3.8:27b-mlx",
			tokens: "179K tok",
			branch: "main",
			permissions: "infinite",
			sessionTime: "8m 12s",
		});
		const kept = fitFooterSegments(segs, 60).map((s) => s.key);
		expect(kept).toContain("mode");
		expect(kept).toContain("approval");
	});

	test("fit keeps display order and drops the highest priority first", () => {
		const segs = buildFooterSegments({
			mode: "Planning",
			model: "m",
			tokens: "1 tok",
			branch: "main",
			sessionTime: "1s",
			user: "u",
		});
		const all = fitFooterSegments(segs, 999).map((s) => s.key);
		expect(all).toEqual(["mode", "model", "tokens", "branch", "user", "session"]);
		const some = fitFooterSegments(segs, 60).map((s) => s.key);
		expect(some).toEqual(["mode", "model", "tokens", "branch"]);
		const width = fitFooterSegments(segs, 60).reduce((n, s) => n + segmentWidth(s) + FOOTER_SEPARATOR.length, 0);
		expect(width).toBeLessThanOrEqual(60);
	});

	test("mode is never dropped, even when nothing fits", () => {
		const kept = fitFooterSegments(buildFooterSegments({ mode: "Implementing", model: "x" }), 5);
		expect(kept.map((s) => s.key)).toEqual(["mode"]);
	});

	test("the FM segment narrows below 120 columns", () => {
		expect(fmSegmentWidth(160)).toBeGreaterThan(fmSegmentWidth(80));
	});
});

describe("quiet states leave the footer (#3130)", () => {
	test("approval ask, the default, is not a segment; anything else is", () => {
		expect(buildFooterSegments({ mode: "Planning", permissions: "ask" }).some((s) => s.key === "approval")).toBe(false);
		expect(buildFooterSegments({ mode: "Planning", permissions: "infinite" }).some((s) => s.key === "approval")).toBe(
			true,
		);
	});

	test("the OS login is not a segment; a signed-in name is", async () => {
		expect((await frame(160, 48, { user: undefined }))[0]).not.toContain("user");
		expect((await frame(160, 48, { user: "james", ready: 3, total: 3 }))[0]).toContain("user james");
	});

	test("providers show only when one is down", async () => {
		expect((await frame(160, 48, { ready: 3, total: 3 }))[0]).not.toContain("providers");
		expect((await frame(160, 48, { ready: 2, total: 3 }))[0]).toContain("providers 2/3");
	});

	test("the audit row: approval ask, judge ready and providers 3/3 are gone", async () => {
		const row = (await frame(160, 48, { ready: 3, total: 3, judge: "ready", user: undefined, tokens: "6.3K tok" }))[0] ?? "";
		for (const quiet of ["approval", "judge", "providers"]) expect(row).not.toContain(quiet);
		expect(row).toContain("mode Planning ^Y");
	});
});

describe("footer hints", () => {
	test("most used first, whole or not at all", () => {
		expect(fitFooterHints(0)).toEqual([]);
		expect(fitFooterHints(6)).toEqual([]);
		expect(fitFooterHints(7)).toEqual(["^X plan"]);
		expect(fitFooterHints(18)).toEqual(["^X plan", "^O expand"]);
		expect(fitFooterHints(999)).toEqual([...FOOTER_HINTS]);
	});
});
