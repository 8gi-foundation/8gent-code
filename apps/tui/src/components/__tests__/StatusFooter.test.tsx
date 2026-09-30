/**
 * The one-row footer (mockup A). It replaced the FM bar, the seven status
 * tiles and the mode strip. These tests render the real BottomBar into fake
 * 80x45 and 160x48 terminals and check height, content and the rules:
 * nothing wraps, ^Y stays visible, unknown values are not shown.
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { render } from "ink";
import { BottomBar } from "../BottomBar.js";
import {
	FOOTER_SEPARATOR,
	buildFooterSegments,
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

describe("BottomBar renders one footer row plus the hint row", () => {
	test("160x48: two rows, every segment present, nothing wraps", async () => {
		const lines = await frame(160, 48);
		expect(lines.length).toBe(2);
		const row = lines[0] ?? "";
		expect(row.startsWith("● 8GENT FM idle")).toBe(true);
		for (const part of [
			"mode Planning ^Y",
			"model qwen3.8:27b-mlx",
			"tokens 179K tok",
			"branch main",
			"session 8m 12s",
			"approval ask",
		]) {
			expect(row).toContain(part);
		}
		expect(row.length).toBeLessThanOrEqual(160);
		expect(lines[1]).toContain("^O expand");
		// The old chrome is gone: no tiles, no chip row, no bordered bar.
		const all = lines.join("\n");
		expect(all).not.toContain("╭");
		expect(all).not.toContain("PLANNING");
		expect(all).not.toContain("AGENTS");
	});

	test("80x45: one footer row that keeps mode, model and tokens", async () => {
		const lines = await frame(80, 45);
		expect(lines.length).toBe(2);
		const row = lines[0] ?? "";
		expect(row).toContain("● 8GENT FM");
		expect(row).toContain("mode Planning ^Y");
		expect(row).toContain("model qwen3.8:27b-mlx");
		expect(row.length).toBeLessThanOrEqual(80);
	});

	test("short terminal drops the hint row, never the footer", async () => {
		const lines = await frame(80, 30);
		expect(lines.length).toBe(1);
		expect(lines[0]).toContain("mode Planning ^Y");
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

	test("loading, ready and failed read as one word after 'judge'", () => {
		for (const judge of ["loading", "ready", "failed"] as const) {
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
		const ready = buildFooterSegments({ mode: "Planning", judge: "ready" }).find((s) => s.key === "judge");
		expect(failed?.color).toBe(infinite?.color);
		expect(ready?.color).not.toBe(infinite?.color);
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

	test("160 columns: 'judge ready' shows beside approval", async () => {
		const row = (await frame(160, 48, { judge: "ready", user: undefined, tokens: "0 tok" }))[0] ?? "";
		expect(row).toContain("approval ask │ judge ready");
		expect(row.length).toBeLessThanOrEqual(160);
	});
});

describe("footer segments", () => {
	test("the approval mode prints as a word, never as ?", () => {
		const seg = buildFooterSegments({ mode: "Planning", permissions: "ask" }).find((s) => s.key === "approval");
		expect(seg?.value).toBe("ask");
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
