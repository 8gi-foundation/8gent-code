/**
 * The 8gent figure-8 mark, drawn from maths rather than letters.
 *
 * A TypeScript port of the design source ~/.8gent/evidence/hud-design/mark/mark8.py
 * (Moira, 8DO). The geometry is one continuous closed curve: a Bernoulli
 * lemniscate turned upright, so the bowls are round and the two strokes cross
 * in a clean X at the waist. The top bowl is scaled to 80% so it reads as a
 * numeral, not an infinity sign on its side.
 *
 * Two renderings:
 * - halfblock: each terminal cell is two square pixels stacked (the upper half
 *   block, U+2580). Each pixel carries an anti-aliased coverage value from a
 *   supersampled distance-to-curve field. Used at intro size.
 * - braille: each cell is a 2x4 dot grid; a dot is lit when it lies on the
 *   stroke. Used at header and spinner size.
 *
 * Nothing here runs at launch. The cells are precomputed into mark8-cells.ts
 * by running this file:
 *
 *     bun apps/tui/src/lib/mark8.ts > apps/tui/src/lib/mark8-cells.ts
 *
 * and a test fails if that file drifts from the maths.
 */

/** Amber at the top of the stroke, orange at the bottom (BRAND.md). */
export const MARK_TOP = "#F07A28";
export const MARK_BOTTOM = "#E8610A";

type Point = readonly [number, number];

/**
 * The upright 8 in unit space, y in [-1, 1], as `n` points along the curve.
 * Lemniscate of Bernoulli rotated upright; points in the top bowl (y < 0) are
 * scaled by `topScale`, then the whole curve is renormalised to fill [-1, 1].
 */
export function curve(n = 6000, topScale = 0.8, xStretch = 1.35): Point[] {
	const pts: [number, number][] = [];
	for (let i = 0; i < n; i++) {
		const t = (2 * Math.PI * i) / n;
		const d = 1 + Math.sin(t) ** 2;
		let y = -Math.cos(t) / d;
		let x = ((Math.sin(t) * Math.cos(t)) / d) * xStretch;
		if (y < 0) {
			x *= topScale;
			y *= topScale;
		}
		pts.push([x, y]);
	}
	let lo = Number.POSITIVE_INFINITY;
	let hi = Number.NEGATIVE_INFINITY;
	for (const [, y] of pts) {
		if (y < lo) lo = y;
		if (y > hi) hi = y;
	}
	const mid = (lo + hi) / 2;
	const half = (hi - lo) / 2;
	return pts.map(([x, y]) => [x / half, (y - mid) / half] as const);
}

/**
 * Distance, in pixels, from any point of a w x h canvas to the curve. The mark
 * spans the canvas height less an 8% margin, centred. Points are bucketed on
 * a 4 px grid and only the 5x5 neighbourhood is searched, as in the source.
 */
export function distanceField(pts: readonly Point[], w: number, h: number): (px: number, py: number) => number {
	const margin = 0.08;
	const scale = (h / 2) * (1 - margin);
	const cx = w / 2;
	const cy = h / 2;
	const B = 4;
	const grid = new Map<string, Point[]>();
	for (const [ux, uy] of pts) {
		const x = cx + ux * scale;
		const y = cy + uy * scale;
		const key = `${Math.floor(x / B)},${Math.floor(y / B)}`;
		let bucket = grid.get(key);
		if (!bucket) {
			bucket = [];
			grid.set(key, bucket);
		}
		bucket.push([x, y]);
	}
	return (px, py) => {
		const gx = Math.floor(px / B);
		const gy = Math.floor(py / B);
		let best = 1e9;
		for (let dx = -2; dx <= 2; dx++) {
			for (let dy = -2; dy <= 2; dy++) {
				const bucket = grid.get(`${gx + dx},${gy + dy}`);
				if (!bucket) continue;
				for (const [x, y] of bucket) {
					const d = (x - px) ** 2 + (y - py) ** 2;
					if (d < best) best = d;
				}
			}
		}
		return Math.sqrt(best);
	};
}

/**
 * Coverage (0..1) of every pixel of a halfblock mark `cols` wide and `rows`
 * tall. The result has rows * 2 pixel rows, each `cols` long. Coverage is the
 * 4x4-supersampled soft stroke: full inside stroke/2, one-pixel falloff.
 */
export function halfblockCoverage(cols: number, rows: number, stroke: number, topScale = 0.8, ss = 4): number[][] {
	const w = cols;
	const h = rows * 2;
	const f = distanceField(curve(6000, topScale), w * ss, h * ss);
	const out: number[][] = [];
	for (let y = 0; y < h; y++) {
		const row: number[] = [];
		for (let x = 0; x < w; x++) {
			let cov = 0;
			for (let sx = 0; sx < ss; sx++) {
				for (let sy = 0; sy < ss; sy++) {
					const d = f(x * ss + sx + 0.5, y * ss + sy + 0.5) / ss;
					cov += Math.max(0, Math.min(1, stroke / 2 + 0.5 - d));
				}
			}
			row.push(cov / (ss * ss));
		}
		out.push(row);
	}
	return out;
}

const BRAILLE_DOTS: readonly (readonly [number, number, number])[] = [
	[0, 0, 0x01],
	[0, 1, 0x02],
	[0, 2, 0x04],
	[1, 0, 0x08],
	[1, 1, 0x10],
	[1, 2, 0x20],
	[0, 3, 0x40],
	[1, 3, 0x80],
];

/** A braille mark `cols` x `rows` cells; unlit cells are spaces. */
export function brailleRows(cols: number, rows: number, stroke: number, topScale = 0.8): string[] {
	const f = distanceField(curve(6000, topScale), cols * 2, rows * 4);
	const out: string[] = [];
	for (let r = 0; r < rows; r++) {
		let line = "";
		for (let c = 0; c < cols; c++) {
			let v = 0;
			for (const [dx, dy, bit] of BRAILLE_DOTS) {
				if (f(c * 2 + dx + 0.5, r * 4 + dy + 0.5) <= stroke / 2) v |= bit;
			}
			line += v ? String.fromCodePoint(0x2800 + v) : " ";
		}
		out.push(line);
	}
	return out;
}

/** Coverage quantised to one byte per pixel, as two hex digits. */
export function encodeCoverage(cov: number[][]): string[] {
	return cov.map((row) =>
		row.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join(""),
	);
}

/**
 * The sizes the TUI uses. The intro size is the reference render
 * (mark/mark-intro.png: 22 x 18, stroke 2.6). The collapse steps down through
 * two halfblock sizes to the braille header mark (4 x 3, stroke 1.3). Strokes
 * shrink with size so the bowls stay open.
 */
export const HALFBLOCK_SIZES = [
	{ id: "intro", cols: 22, rows: 18, stroke: 2.6 },
	{ id: "medium", cols: 15, rows: 12, stroke: 2.0 },
	{ id: "small", cols: 10, rows: 8, stroke: 1.6 },
] as const;

export const BRAILLE_SIZE = { id: "header", cols: 4, rows: 3, stroke: 1.3 } as const;

/** Source text of mark8-cells.ts. */
export function generateCellsModule(): string {
	const lines: string[] = [
		"// Generated by `bun apps/tui/src/lib/mark8.ts > apps/tui/src/lib/mark8-cells.ts`.",
		"// Do not edit by hand: mark8.test.ts fails if this drifts from the maths in mark8.ts.",
		"",
		"export interface HalfblockMark {",
		"\treadonly cols: number;",
		"\treadonly rows: number;",
		"\t/** rows * 2 pixel rows; each is cols coverage bytes as hex pairs (00 = empty, ff = full). */",
		"\treadonly coverage: readonly string[];",
		"}",
		"",
	];
	for (const s of HALFBLOCK_SIZES) {
		const enc = encodeCoverage(halfblockCoverage(s.cols, s.rows, s.stroke));
		lines.push(`export const MARK_${s.id.toUpperCase()}: HalfblockMark = {`);
		lines.push(`\tcols: ${s.cols},`);
		lines.push(`\trows: ${s.rows},`);
		lines.push("\tcoverage: [");
		for (const row of enc) lines.push(`\t\t"${row}",`);
		lines.push("\t],");
		lines.push("};");
		lines.push("");
	}
	const b = brailleRows(BRAILLE_SIZE.cols, BRAILLE_SIZE.rows, BRAILLE_SIZE.stroke);
	lines.push("/** Header and spinner size, braille. */");
	lines.push(`export const MARK_HEADER: readonly string[] = [${b.map((r) => JSON.stringify(r)).join(", ")}];`);
	lines.push("");
	return lines.join("\n");
}

if (import.meta.main) {
	process.stdout.write(generateCellsModule());
}
