/**
 * The spinner beside the working verb has to trace a figure of eight, not the
 * square the stock braille spinner walks. "Figure of eight" is a claim about
 * the shape of the path, so these tests check the shape itself: every dot
 * visited once, each step to a neighbouring dot, and two diagonal strokes that
 * actually cross in the middle of the cell. A square perimeter passes the
 * first two and fails the third, which is the point.
 */
import { describe, expect, test } from "bun:test";

import {
	BRAILLE_BASE,
	type CellPoint,
	FIGURE_EIGHT_FRAMES,
	FIGURE_EIGHT_INTERVAL_MS,
	FIGURE_EIGHT_PATH,
	FIGURE_EIGHT_STILL,
	dotBit,
	figureEightFrame,
} from "../lib/figure-eight";

const step = (index: number): [CellPoint, CellPoint] => [
	FIGURE_EIGHT_PATH[index]!,
	FIGURE_EIGHT_PATH[(index + 1) % FIGURE_EIGHT_PATH.length]!,
];

const isDiagonal = ([from, to]: [CellPoint, CellPoint]) =>
	from.col !== to.col && from.row !== to.row;

/** True when two open segments cross, which is what a lemniscate does. */
function segmentsCross(a: [CellPoint, CellPoint], b: [CellPoint, CellPoint]): boolean {
	const cross = (o: CellPoint, p: CellPoint, q: CellPoint) =>
		Math.sign((p.col - o.col) * (q.row - o.row) - (p.row - o.row) * (q.col - o.col));
	const [a1, a2] = a;
	const [b1, b2] = b;
	return cross(a1, a2, b1) !== cross(a1, a2, b2) && cross(b1, b2, a1) !== cross(b1, b2, a2);
}

describe("the path", () => {
	test("visits all eight dots of the braille cell exactly once", () => {
		expect(FIGURE_EIGHT_PATH).toHaveLength(8);
		const seen = new Set(FIGURE_EIGHT_PATH.map((p) => `${p.col},${p.row}`));
		expect(seen.size).toBe(8);
		const bits = FIGURE_EIGHT_PATH.map(dotBit);
		expect(new Set(bits).size).toBe(8);
		// Every dot in the cell, so the motion uses the whole glyph.
		expect(bits.reduce((all, bit) => all | bit, 0)).toBe(0xff);
	});

	test("never jumps: each step moves to a touching dot, and the loop closes", () => {
		for (let i = 0; i < FIGURE_EIGHT_PATH.length; i++) {
			const [from, to] = step(i);
			const distance = Math.max(Math.abs(from.col - to.col), Math.abs(from.row - to.row));
			expect(distance).toBe(1);
		}
	});

	test("crosses itself once in the middle, which is what makes it an 8", () => {
		const diagonals = FIGURE_EIGHT_PATH.map((_, i) => step(i)).filter(isDiagonal);
		expect(diagonals).toHaveLength(2);
		expect(segmentsCross(diagonals[0]!, diagonals[1]!)).toBe(true);
		// The crossing sits between the two middle rows, not off at an edge.
		for (const [from, to] of diagonals) {
			expect(Math.min(from.row, to.row)).toBe(1);
			expect(Math.max(from.row, to.row)).toBe(2);
		}
	});

	test("a square perimeter would fail the crossing test", () => {
		const square: CellPoint[] = [
			{ col: 0, row: 0 },
			{ col: 1, row: 0 },
			{ col: 1, row: 1 },
			{ col: 1, row: 2 },
			{ col: 1, row: 3 },
			{ col: 0, row: 3 },
			{ col: 0, row: 2 },
			{ col: 0, row: 1 },
		];
		const diagonals = square
			.map((from, i): [CellPoint, CellPoint] => [from, square[(i + 1) % square.length]!])
			.filter(isDiagonal);
		expect(diagonals).toHaveLength(0);
	});
});

describe("the frames", () => {
	test("are eight distinct braille characters", () => {
		expect(FIGURE_EIGHT_FRAMES).toHaveLength(8);
		expect(new Set(FIGURE_EIGHT_FRAMES).size).toBe(8);
		for (const frame of FIGURE_EIGHT_FRAMES) {
			expect([...frame]).toHaveLength(1);
			const code = frame.codePointAt(0)!;
			expect(code).toBeGreaterThanOrEqual(BRAILLE_BASE);
			expect(code).toBeLessThanOrEqual(BRAILLE_BASE + 0xff);
		}
	});

	test("light the current dot and the one before it, so the head has a tail", () => {
		FIGURE_EIGHT_FRAMES.forEach((frame, index) => {
			const previous = FIGURE_EIGHT_PATH[(index + 7) % 8]!;
			const bits = frame.codePointAt(0)! - BRAILLE_BASE;
			expect(bits & dotBit(FIGURE_EIGHT_PATH[index]!)).toBeGreaterThan(0);
			expect(bits & dotBit(previous)).toBeGreaterThan(0);
			expect(bits.toString(2).split("1").length - 1).toBe(2);
		});
	});

	test("cycle forever in both directions and hold still when asked", () => {
		expect(figureEightFrame(0)).toBe(FIGURE_EIGHT_FRAMES[0]!);
		expect(figureEightFrame(8)).toBe(FIGURE_EIGHT_FRAMES[0]!);
		expect(figureEightFrame(11)).toBe(FIGURE_EIGHT_FRAMES[3]!);
		expect(figureEightFrame(-1)).toBe(FIGURE_EIGHT_FRAMES[7]!);
		expect(FIGURE_EIGHT_STILL).toBe(FIGURE_EIGHT_FRAMES[0]!);
	});

	test("run at a pace a person can follow", () => {
		expect(FIGURE_EIGHT_INTERVAL_MS).toBeGreaterThanOrEqual(60);
		expect(FIGURE_EIGHT_INTERVAL_MS).toBeLessThanOrEqual(150);
	});
});
