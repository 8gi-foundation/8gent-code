import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MARK_HEADER, MARK_INTRO } from "./mark8-cells.js";
import { brailleRows, curve, generateCellsModule } from "./mark8.js";

describe("the figure-8 mark", () => {
	test("the precomputed cells match the maths (regenerate with bun apps/tui/src/lib/mark8.ts)", () => {
		const onDisk = readFileSync(join(import.meta.dir, "mark8-cells.ts"), "utf-8");
		expect(onDisk).toBe(generateCellsModule());
	});

	test("the header mark is the reference braille 8 from mark8.py (4 x 3, stroke 1.3)", () => {
		expect([...MARK_HEADER]).toEqual(["⢰⡋⢙⡆", "⢀⠽⠯⡀", "⠻⣄⣠⠟"]);
		expect(brailleRows(4, 3, 1.3)).toEqual([...MARK_HEADER]);
	});

	test("the intro marks are braille only: smooth dots, never half blocks (#3159)", () => {
		for (const rows of Object.values(MARK_INTRO)) {
			for (const ch of rows.join("")) {
				expect(ch === " " || (ch.codePointAt(0)! >= 0x2800 && ch.codePointAt(0)! <= 0x28ff)).toBe(true);
			}
		}
	});

	test("the large intro mark is an upright 8: top bowl narrower, strokes crossing at the waist", () => {
		const rows = MARK_INTRO.large;
		const width = (line: string) => line.trim().length;
		const top = Math.max(...rows.slice(0, 5).map(width));
		const bottom = Math.max(...rows.slice(6).map(width));
		expect(top).toBeLessThan(bottom);
		// The waist row is the narrowest inked row between the bowls.
		const waist = Math.min(...rows.slice(3, 8).map(width));
		expect(waist).toBeLessThanOrEqual(4);
		expect(rows.length).toBe(12);
		expect(rows[0]!.length).toBe(18);
	});

	test("every intro size keeps both bowls open (an empty cell inside each)", () => {
		for (const rows of Object.values(MARK_INTRO)) {
			const h = rows.length;
			const inner = (r: number) => rows[r]!.slice(Math.floor(rows[0]!.length / 2) - 1, Math.floor(rows[0]!.length / 2) + 1);
			expect(inner(1)).toMatch(/^ +$/);
			expect(inner(h - 2)).toMatch(/^ +$/);
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
