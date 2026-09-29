import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MARK_HEADER, MARK_INTRO, MARK_MEDIUM, MARK_SMALL } from "./mark8-cells.js";
import { brailleRows, curve, generateCellsModule } from "./mark8.js";

/** Pixels at half coverage or more, as # and . per pixel row. */
function silhouette(coverage: readonly string[]): string[] {
	return coverage.map((row) => {
		let s = "";
		for (let i = 0; i < row.length; i += 2) s += Number.parseInt(row.slice(i, i + 2), 16) >= 128 ? "#" : ".";
		return s;
	});
}

describe("the figure-8 mark", () => {
	test("the precomputed cells match the maths (regenerate with bun apps/tui/src/lib/mark8.ts)", () => {
		const onDisk = readFileSync(join(import.meta.dir, "mark8-cells.ts"), "utf-8");
		expect(onDisk).toBe(generateCellsModule());
	});

	test("the header mark is the reference braille 8 from mark8.py (4 x 3, stroke 1.3)", () => {
		expect([...MARK_HEADER]).toEqual(["⢰⡋⢙⡆", "⢀⠽⠯⡀", "⠻⣄⣠⠟"]);
		expect(brailleRows(4, 3, 1.3)).toEqual([...MARK_HEADER]);
	});

	test("the intro mark is an upright 8: round bowls, top bowl smaller, strokes crossing in an X", () => {
		expect(silhouette(MARK_INTRO.coverage)).toEqual([
			"........######........",
			"......##########......",
			".....############.....",
			"....####......####....",
			"...###..........###...",
			"...###..........###...",
			"...##............##...",
			"...##............##...",
			"...###..........###...",
			"...###..........###...",
			"....###........###....",
			"....###........###....",
			".....###......###.....",
			"......####..####......",
			".......########.......",
			"........######........",
			"........######........",
			".......########.......",
			"......####..####......",
			".....####....####.....",
			"....####......####....",
			"...####........####...",
			"..####..........####..",
			"..###............###..",
			".###..............###.",
			".###..............###.",
			".###..............###.",
			".###..............###.",
			".###..............###.",
			".###..............###.",
			"..###............###..",
			"..####..........####..",
			"...####........####...",
			"....##############....",
			".....############.....",
			"........######........",
		]);
	});

	test("every size is anti-aliased: partial coverage exists, not just on and off", () => {
		for (const m of [MARK_INTRO, MARK_MEDIUM, MARK_SMALL]) {
			const values = new Set<number>();
			for (const row of m.coverage) {
				for (let i = 0; i < row.length; i += 2) values.add(Number.parseInt(row.slice(i, i + 2), 16));
			}
			const partial = [...values].filter((v) => v > 16 && v < 240);
			expect(partial.length).toBeGreaterThan(10);
			expect(m.coverage.length).toBe(m.rows * 2);
		}
	});

	test("the curve is mirror-symmetric and one closed loop", () => {
		const pts = curve(400);
		const first = pts[0]!;
		const last = pts.at(-1)!;
		expect(Math.hypot(first[0] - last[0], first[1] - last[1])).toBeLessThan(0.05);
		// For every point there is a mirrored one across the vertical axis.
		for (const [x, y] of pts.filter((_, i) => i % 40 === 0)) {
			const nearest = Math.min(...pts.map(([u, v]) => Math.hypot(u + x, v - y)));
			expect(nearest).toBeLessThan(0.03);
		}
	});
});
