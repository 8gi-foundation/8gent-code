/**
 * NoiseField - Drifting value-noise pattern.
 *
 * A small value-noise function (deterministic 2D hash + bilerp) is sampled
 * across the grid, biased by `params.noise` and `params.distribution`. The
 * field drifts horizontally over time at a rate set by `params.speed`.
 * Glyphs map intensity to ` · ∙ ▪ ◾ █`. Colour from amber-safe hue ramp.
 */

import { Box, Text } from "ink";
import React from "react";
import type { OperatorProps } from "./types.js";
import { sampleAmber, safeHueToColor } from "../../lib/amber-palette.js";

const GLYPHS = [" ", "·", "∙", "▪", "◾", "█"];

function hash2(x: number, y: number, seed: number): number {
	const n = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + seed;
	const m = (n ^ (n >>> 13)) * 1274126177;
	return ((m ^ (m >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number, seed: number): number {
	const xi = Math.floor(x);
	const yi = Math.floor(y);
	const xf = x - xi;
	const yf = y - yi;
	const v00 = hash2(xi, yi, seed);
	const v10 = hash2(xi + 1, yi, seed);
	const v01 = hash2(xi, yi + 1, seed);
	const v11 = hash2(xi + 1, yi + 1, seed);
	const u = xf * xf * (3 - 2 * xf);
	const v = yf * yf * (3 - 2 * yf);
	return v00 * (1 - u) * (1 - v) + v10 * u * (1 - v) + v01 * (1 - u) * v + v11 * u * v;
}

export function NoiseField({ width, height, params, tick, brightness, avoid }: OperatorProps): React.ReactElement {
	const drift = tick * (0.05 + params.speed * 0.15);
	const scale = 0.35 + params.size * 0.4;
	const distortion = 0.2 + params.noise * 0.6;
	const seed = 1337;

	const rows: React.ReactElement[] = [];
	for (let y = 0; y < height; y++) {
		const segments: React.ReactElement[] = [];
		let runColor = "";
		let runText = "";
		let segIdx = 0;
		const flush = () => {
			if (!runText) return;
			segments.push(
				<Text key={`s${segIdx++}`} color={runColor || undefined}>
					{runText}
				</Text>,
			);
			runText = "";
			runColor = "";
		};
		for (let x = 0; x < width; x++) {
			if (avoid && x >= avoid.x && x < avoid.x + avoid.width && y >= avoid.y && y < avoid.y + avoid.height) {
				flush();
				segments.push(<Text key={`s${segIdx++}`}> </Text>);
				continue;
			}
			const nx = (x + drift) * scale * 0.3;
			const ny = y * scale * 0.6;
			const v = valueNoise(nx, ny, seed) * (1 - distortion) + valueNoise(nx * 2, ny * 2, seed + 1) * distortion;
			const intensity = Math.max(0, Math.min(1, v * (0.7 + params.density * 0.5)));
			const idx = Math.min(GLYPHS.length - 1, Math.floor(intensity * GLYPHS.length));
			const glyph = GLYPHS[idx]!;
			const color =
				idx <= 1
					? sampleAmber(intensity * brightness * 0.4)
					: safeHueToColor(params.hue, intensity * brightness, params.saturation);
			if (color === runColor) {
				runText += glyph;
			} else {
				flush();
				runText = glyph;
				runColor = color;
			}
		}
		flush();
		rows.push(<Box key={`row-${y}`}>{segments}</Box>);
	}

	return <Box flexDirection="column">{rows}</Box>;
}
