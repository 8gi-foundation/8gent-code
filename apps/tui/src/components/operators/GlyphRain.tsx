/**
 * GlyphRain - Slow Matrix-style top-to-bottom fall.
 *
 * Each column has a deterministic "drop" head position that descends per
 * tick. Below the head, a tail of dimming glyphs trails off. Glyphs are
 * sampled from a small alphabet. Colours stay strictly inside the
 * amber-safe palette - no green Matrix here, this is Bladerunner amber.
 */

import { Box, Text } from "ink";
import React from "react";
import type { OperatorProps } from "./types.js";
import { sampleAmber, safeHueToColor } from "../../lib/amber-palette.js";

const ALPHABET = ["0", "1", "8", "ᚠ", "ᛏ", "▪", "·", "*", "◇", "◆"];

function colHash(x: number, salt: number): number {
	const a = Math.imul(x | 0, 374761393) ^ salt;
	const b = Math.imul(a, 668265263);
	return ((b ^ (b >>> 13)) >>> 0) / 4294967296;
}

export function GlyphRain({ width, height, params, tick, brightness, avoid }: OperatorProps): React.ReactElement {
	const speed = 0.12 + params.speed * 0.45;
	const tailLen = Math.max(2, Math.round(2 + params.size * 4));
	const aliveCutoff = 1 - params.density * 0.85;

	const grid: Array<Array<{ glyph: string; color: string }>> = [];
	for (let y = 0; y < height; y++) {
		grid.push(Array.from({ length: width }, () => ({ glyph: " ", color: "" })));
	}

	for (let x = 0; x < width; x++) {
		const colSeed = colHash(x, 17);
		if (colSeed < aliveCutoff) continue;
		const colSpeed = speed * (0.5 + colSeed * 0.8);
		const totalRange = height + tailLen + 4;
		const headPos = ((tick * colSpeed + colSeed * totalRange) % totalRange) - tailLen - 2;

		for (let t = 0; t < tailLen + 1; t++) {
			const y = Math.floor(headPos - t);
			if (y < 0 || y >= height) continue;
			if (avoid && x >= avoid.x && x < avoid.x + avoid.width && y >= avoid.y && y < avoid.y + avoid.height) {
				continue;
			}
			const wobble = Math.floor(tick * (0.05 + params.noise * 0.3) + x * 7 + y * 3);
			const glyph = ALPHABET[(wobble + Math.floor(colSeed * ALPHABET.length * 5)) % ALPHABET.length]!;
			const intensity = 1 - t / (tailLen + 1);
			const color =
				t === 0
					? safeHueToColor(params.hue, brightness, params.saturation)
					: sampleAmber(Math.max(0.15, intensity * brightness * 0.85));
			grid[y]![x] = { glyph, color };
		}
	}

	const rows: React.ReactElement[] = [];
	for (let y = 0; y < height; y++) {
		const segs: React.ReactElement[] = [];
		let runText = "";
		let runColor = "";
		let segIdx = 0;
		const flush = () => {
			if (!runText) return;
			segs.push(
				<Text key={`s${segIdx++}`} color={runColor || undefined}>
					{runText}
				</Text>,
			);
			runText = "";
			runColor = "";
		};
		for (let x = 0; x < width; x++) {
			const cell = grid[y]![x]!;
			if (cell.color === runColor) {
				runText += cell.glyph;
			} else {
				flush();
				runText = cell.glyph;
				runColor = cell.color;
			}
		}
		flush();
		rows.push(<Box key={`row-${y}`}>{segs}</Box>);
	}

	return <Box flexDirection="column">{rows}</Box>;
}
