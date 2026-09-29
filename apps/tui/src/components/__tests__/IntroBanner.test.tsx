/**
 * The launch splash (INTRO-AUDIT.md, MOTION.md motion 4). Pure timing and
 * layout are tested directly; the component is rendered through real Ink
 * into a fake terminal and driven with real keystrokes.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { type Instance, render } from "ink";
import { MOTION_BUDGET_MS } from "../../lib/motion.js";
import { palettes } from "../../theme.js";
import {
	COLLAPSE_EASE,
	COLLAPSE_FRAME_MS,
	HEADER_EIGHT,
	INTRO_BLOCK_WIDTH,
	INTRO_DONE_MS,
	INTRO_HINT_TOKEN,
	INTRO_LINE_MS,
	INTRO_LINE_TOKENS,
	INTRO_LINES,
	IntroBanner,
	carriedText,
	collapseFrames,
	introLayout,
	typedLine,
} from "../IntroBanner.js";
import { markSize } from "../Mark8.js";

// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

class FakeStdin extends EventEmitter {
	isTTY = true;
	private queue: string[] = [];
	setRawMode() {}
	setEncoding() {}
	ref() {}
	unref() {}
	read(): string | null {
		return this.queue.shift() ?? null;
	}
	feed(chunk: string) {
		this.queue.push(chunk);
		this.emit("readable");
	}
}

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
		out.frames.push(strip(s));
		return true;
	};
	return out;
}

let instance: Instance | null = null;
afterEach(() => {
	instance?.unmount();
	instance = null;
});

function mount(props: Partial<React.ComponentProps<typeof IntroBanner>> = {}, cols = 100, rows = 32) {
	const stdin = new FakeStdin();
	const stdout = fakeStdout(cols, rows);
	const calls: (string | undefined)[] = [];
	instance = render(
		<IntroBanner sound={false} rich onDone={(c) => calls.push(c)} version="0.18.0" {...props} />,
		{
			stdin: stdin as unknown as NodeJS.ReadStream,
			stdout: stdout as unknown as NodeJS.WriteStream,
			debug: true,
			patchConsole: false,
			exitOnCtrlC: false,
		},
	);
	return { stdin, stdout, calls, last: () => stdout.frames.at(-1) ?? "" };
}

describe("intro timing", () => {
	test("the whole splash is about 1.5 s at most", () => {
		expect(INTRO_DONE_MS).toBeLessThanOrEqual(1500);
	});

	test("every motion is inside the budget: each typed line and the collapse", () => {
		expect(INTRO_LINE_MS).toBeLessThanOrEqual(MOTION_BUDGET_MS);
		expect(COLLAPSE_EASE.length * COLLAPSE_FRAME_MS).toBeLessThan(MOTION_BUDGET_MS);
	});

	test("lines only grow to the right, and reduced motion shows them whole", () => {
		let prev = "";
		for (let ms = 0; ms <= 1200; ms += 30) {
			const s = typedLine(0, ms, true);
			expect(INTRO_LINES[0].startsWith(s)).toBe(true);
			expect(s.length).toBeGreaterThanOrEqual(prev.length);
			prev = s;
		}
		expect(prev).toBe(INTRO_LINES[0]);
		expect(typedLine(2, 0, false)).toBe(INTRO_LINES[2]);
	});
});

describe("intro layout", () => {
	test("the block is centred vertically, not parked at the top", () => {
		const l = introLayout(100, 48, true);
		const height = markSize(l.size, true).rows + 8;
		const below = 48 - l.top - height;
		expect(Math.abs(l.top - below)).toBeLessThanOrEqual(1);
		expect(l.top).toBeGreaterThan(5);
	});

	test("the mark steps down so the block always fits", () => {
		for (const rows of [16, 20, 24, 30, 48]) {
			const l = introLayout(80, rows, true);
			expect(l.top + markSize(l.size, true).rows + 8).toBeLessThanOrEqual(Math.max(rows, 11));
		}
		expect(introLayout(80, 45, true).size).toBe("intro");
		expect(introLayout(80, 24, true).size).toBe("medium");
	});

	test("the collapse shrinks toward the header and lands on its 8", () => {
		for (const rich of [true, false]) {
			const l = introLayout(100, 32, rich);
			const frames = collapseFrames(l, rich);
			expect(frames.length).toBe(COLLAPSE_EASE.length);
			const lastFrame = frames.at(-1)!;
			const m = markSize(lastFrame.size, rich);
			// The final mark covers the header's 8.
			expect(lastFrame.top).toBeLessThanOrEqual(HEADER_EIGHT.row);
			expect(lastFrame.top + m.rows).toBeGreaterThan(HEADER_EIGHT.row);
			expect(lastFrame.left).toBeLessThanOrEqual(HEADER_EIGHT.col);
			expect(lastFrame.left + m.cols).toBeGreaterThan(HEADER_EIGHT.col);
			// Monotonic travel: always up and to the left, never back.
			for (let i = 1; i < frames.length; i++) {
				expect(frames[i]!.top).toBeLessThanOrEqual(frames[i - 1]!.top);
				expect(frames[i]!.left).toBeLessThanOrEqual(frames[i - 1]!.left);
			}
		}
	});
});

describe("intro copy and colour", () => {
	test("no em dashes, and the body line reads as one sentence style", () => {
		for (const l of INTRO_LINES) expect(l).not.toContain("\u2014");
		expect(INTRO_LINES[2]).toBe("Infinite General Intelligence. Free, local, open.");
	});

	test("every line and the hint are at least 4.5:1 on the background, in both themes", () => {
		const lum = (hex: string) => {
			const c = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
			const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [
				number,
				number,
				number,
			];
			return 0.2126 * r + 0.7152 * g + 0.0722 * b;
		};
		const ratio = (a: string, b: string) => {
			const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
			return (hi + 0.05) / (lo + 0.05);
		};
		for (const p of [palettes.dark, palettes.light]) {
			for (const token of [...INTRO_LINE_TOKENS, INTRO_HINT_TOKEN]) {
				expect(ratio(p[token], p.bg)).toBeGreaterThanOrEqual(4.5);
			}
		}
	});

	test("keys typed to skip are handed on; Enter, space and chords are not", () => {
		expect(carriedText("h", {})).toBe("h");
		expect(carriedText("/skip all", {})).toBe("/skip all");
		expect(carriedText("\r", { return: true })).toBe("");
		expect(carriedText(" ", {})).toBe("");
		expect(carriedText("a", { ctrl: true })).toBe("");
		expect(carriedText("", { escape: true })).toBe("");
	});
});

describe("the splash in a real Ink render", () => {
	test("any key skips at once, from the first frame, and hands the key on", async () => {
		const { stdin, calls } = mount();
		await tick(40);
		stdin.feed("h");
		await tick(40);
		expect(calls).toEqual(["h"]);
	});

	test("Enter skips too, and carries nothing", async () => {
		const { stdin, calls } = mount();
		await tick(40);
		stdin.feed("\r");
		await tick(40);
		expect(calls).toEqual([""]);
	});

	test("it finishes on its own inside 1.5 s", async () => {
		const { calls } = mount({ speed: 10 });
		await tick(Math.ceil(INTRO_DONE_MS / 10) + 120);
		expect(calls.length).toBe(1);
	});

	test("the typed lines hold one left column while they type: no sideways jitter", async () => {
		const { stdout } = mount({ speed: 2 });
		await tick(Math.ceil(1200 / 2));
		const lefts = new Set<number>();
		for (const f of stdout.frames) {
			for (const row of f.split("\n")) {
				const i = row.indexOf("Your intelligence");
				if (i < 0) continue;
				// Only lines that have started typing and have not finished yet.
				if (row.includes(INTRO_LINES[0])) continue;
				lefts.add(i);
			}
		}
		// Typing frames exist and the column never moved.
		expect(lefts.size).toBe(1);
		expect([...lefts][0]).toBe(Math.floor((100 - INTRO_BLOCK_WIDTH) / 2));
	});

	test("reduced motion: the final frame at once, no typing and no collapse", async () => {
		const { stdout } = mount({ animate: false, speed: 10 });
		await tick(30);
		const first = stdout.frames.find((f) => f.includes("any key to continue")) ?? "";
		for (const l of INTRO_LINES) expect(first).toContain(l);
		expect(first).toContain("v0.18.0");
		await tick(Math.ceil(INTRO_DONE_MS / 10) + 60);
		// Every painted frame had the full copy; none was a collapse frame.
		for (const f of stdout.frames.filter((f) => f.trim())) expect(f).toContain(INTRO_LINES[2]);
	});

	test("the mark is the anti-aliased halfblock 8, or a plain 8 where blocks cannot be drawn", async () => {
		const rich = mount({ animate: false, speed: 0.1 });
		await tick(30);
		expect(rich.last()).toContain("▀");
		instance?.unmount();
		const plain = mount({ animate: false, speed: 0.1, rich: false });
		await tick(30);
		const frame = plain.last();
		expect(frame).not.toContain("▀");
		expect(frame).not.toContain("▄");
		expect(frame.split("\n").some((r) => r.trim() === "8")).toBe(true);
	});
});
