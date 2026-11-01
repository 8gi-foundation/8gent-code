import { describe, expect, test } from "bun:test";
import {
	ALIVE_FRAME_MS,
	INTRO_DONE_MS,
	INTRO_LINE,
	INTRO_NAME,
	INTRO_PALETTE,
	LANDED_MS,
	type Run,
	dotsOf,
	flight,
	introDots,
	introFrame,
	introLayout,
	introSize,
	startOf,
	twinkleOff,
	waveAt,
} from "./intro-converge.js";
import { MARK_INTRO } from "./mark8-cells.js";

const text = (row: Run[]) => row.map((r) => r.text).join("");
const screen = (rows: Run[][]) => rows.map(text);

function frameAt(t: number, cols = 160, rows = 48, alive = true) {
	const size = introSize(cols, rows)!;
	const layout = introLayout(cols, rows, size);
	return {
		layout,
		rows: introFrame(cols, rows, layout, introDots(size), t, { alive, hint: "any key skips" }),
	};
}

describe("intro B: timing", () => {
	test("the whole splash stays inside the old 1.5 s budget", () => {
		expect(INTRO_DONE_MS).toBeLessThanOrEqual(1490);
		expect(LANDED_MS).toBeLessThan(INTRO_DONE_MS - 400);
	});

	test("every dot has left the ring by the stagger and is home by LANDED_MS", () => {
		const n = introDots("large").length;
		for (let i = 0; i < n; i++) {
			expect(flight(i, 0)).toBe(0);
			expect(flight(i, LANDED_MS)).toBe(1);
		}
	});

	test("the ring and the twinkle are the same on every run (no Math.random)", () => {
		expect(startOf(7, 160, 48)).toEqual(startOf(7, 160, 48));
		expect(screen(frameAt(400).rows)).toEqual(screen(frameAt(400).rows));
		expect(screen(frameAt(1300).rows)).toEqual(screen(frameAt(1300).rows));
	});
});

describe("intro B: the mark", () => {
	test("at rest it is exactly the braille 8, dot for dot", () => {
		const { layout, rows } = frameAt(LANDED_MS + 200, 160, 48, false);
		const mark = rows.slice(layout.top, layout.top + layout.markRows).map((r) =>
			text(r)
				.padEnd(160)
				.slice(layout.left, layout.left + layout.markCols),
		);
		expect(mark.map((l) => l.trimEnd())).toEqual(MARK_INTRO.large.map((l) => l.trimEnd()));
	});

	test("before landing the dots are spread across the screen, not on the mark", () => {
		const { layout, rows } = frameAt(40);
		const lit = rows
			.flatMap((r, i) => [...text(r)].map((ch, c) => ({ ch, r: i, c })))
			.filter((x) => x.ch >= "⠁" && x.ch <= "⣿");
		const outside = lit.filter(
			(x) =>
				x.r < layout.top ||
				x.r >= layout.top + layout.markRows ||
				x.c < layout.left ||
				x.c >= layout.left + layout.markCols,
		);
		expect(outside.length).toBeGreaterThan(lit.length * 0.8);
	});

	test("the mark is braille only at every size: no half blocks", () => {
		for (const [cols, rows] of [
			[160, 48],
			[80, 45],
			[80, 24],
		] as const) {
			for (const t of [0, 300, 700, LANDED_MS, 1300]) {
				const s = screen(frameAt(t, cols, rows).rows).join("");
				expect(s).not.toMatch(/[▀-▟]/);
			}
		}
	});

	test("sizes step down with the terminal, and a tiny terminal gets no splash", () => {
		expect(introSize(160, 48)).toBe("large");
		expect(introSize(80, 30)).toBe("medium");
		expect(introSize(80, 24)).toBe("small");
		expect(introSize(40, 10)).toBeNull();
		expect(introSize(20, 30)).toBeNull();
	});

	test("dotsOf reads every lit braille dot", () => {
		expect(dotsOf(["⣿"]).length).toBe(8);
		expect(dotsOf(["⠁ ⢀"])).toEqual([
			{ x: 0, y: 0 },
			{ x: 5, y: 3 },
		]);
	});
});

describe("intro B: alive", () => {
	test("once home the mark changes only on the 8 fps beat", () => {
		const a = screen(frameAt(10 * ALIVE_FRAME_MS).rows);
		const b = screen(frameAt(11 * ALIVE_FRAME_MS - 1).rows);
		expect(b).toEqual(a);
	});

	test("it is alive: over a second some dots blink off and the wave moves", () => {
		const n = introDots("large").length;
		let blinks = 0;
		for (let beat = 0; beat < 8; beat++) {
			for (let i = 0; i < n; i++) if (twinkleOff(i, 2000 + beat * ALIVE_FRAME_MS)) blinks++;
		}
		// About one dot in seventy per beat: alive, not flickering.
		expect(blinks).toBeGreaterThan(8 * n * 0.005);
		expect(blinks).toBeLessThan(8 * n * 0.04);
		expect(waveAt(10, 48, 0)).not.toBeCloseTo(waveAt(10, 48, 600), 2);
	});

	test("with alive off (NO_COLOR) the landed mark holds perfectly still", () => {
		expect(screen(frameAt(1100, 160, 48, false).rows)).toEqual(
			screen(frameAt(1450, 160, 48, false).rows),
		);
	});
});

describe("intro B: layout and copy", () => {
	test("the name and the line sit on the mark's own axis (no off-axis column)", () => {
		for (const [cols, rows] of [
			[160, 48],
			[80, 45],
			[80, 24],
			[101, 33],
		] as const) {
			const size = introSize(cols, rows)!;
			const l = introLayout(cols, rows, size);
			const markCentre = l.left + l.markCols / 2;
			expect(Math.abs(l.nameLeft + INTRO_NAME.length / 2 - markCentre)).toBeLessThanOrEqual(0.5);
			expect(Math.abs(l.lineLeft + INTRO_LINE.length / 2 - markCentre)).toBeLessThanOrEqual(0.5);
		}
	});

	test("the block is centred vertically and fits", () => {
		for (const [cols, rows] of [
			[160, 48],
			[80, 45],
			[80, 24],
		] as const) {
			const l = introLayout(cols, rows, introSize(cols, rows)!);
			const below = rows - (l.lineRow + 1);
			expect(Math.abs(l.top - below)).toBeLessThanOrEqual(1);
		}
	});

	test("the text comes up after the mark lands, in the final frame reads in full", () => {
		expect(screen(frameAt(LANDED_MS - 10).rows).join("\n")).not.toContain(INTRO_NAME);
		const last = screen(frameAt(1400).rows).join("\n");
		expect(last).toContain(INTRO_NAME);
		expect(last).toContain(INTRO_LINE);
		expect(last).toContain("any key skips");
	});

	test("copy and palette: no em dashes; no purple or pink (hues stay orange)", () => {
		for (const s of [INTRO_NAME, INTRO_LINE]) expect(s).not.toMatch(/[–—]/);
		for (const hex of Object.values(INTRO_PALETTE)) {
			const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255) as [
				number,
				number,
				number,
			];
			const max = Math.max(r, g, b);
			const min = Math.min(r, g, b);
			if (max - min < 0.08) continue; // grey
			let h = 0;
			if (max === r) h = ((g - b) / (max - min)) * 60;
			else if (max === g) h = ((b - r) / (max - min)) * 60 + 120;
			else h = ((r - g) / (max - min)) * 60 + 240;
			if (h < 0) h += 360;
			expect(h >= 270 && h <= 350).toBe(false);
		}
	});
});
