/**
 * GradientSpectrum - Animated equaliser bars.
 *
 * Each column draws a Unicode block bar whose height modulates over time.
 * Heights derive from a sum of sines so neighbouring columns correlate
 * (looks like a real audio spectrum, not random noise). Block partials
 * `▁ ▂ ▃ ▄ ▅ ▆ ▇ █` give sub-row resolution.
 */

import { Box, Text } from "ink";
import React from "react";
import type { OperatorProps } from "./types.js";
import { sampleAmber, safeHueToColor } from "../../lib/amber-palette.js";

const PARTIALS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export function GradientSpectrum({ width, height, params, tick, brightness, avoid }: OperatorProps): React.ReactElement {
	const speed = 0.05 + params.speed * 0.25;
	const t = tick * speed;
	const heights: number[] = [];
	for (let x = 0; x < width; x++) {
		const phase = (x / Math.max(1, width)) * Math.PI * (2 + params.distribution * 4);
		const base =
			0.5 +
			0.25 * Math.sin(phase + t) +
			0.15 * Math.sin(phase * 2 + t * 1.7) +
			0.1 * Math.sin(phase * 0.5 - t * 0.6);
		const noise = (Math.sin(x * 13.37 + t * 11) * 0.5 + 0.5) * params.noise * 0.3;
		const intensity = Math.max(0.05, Math.min(1, (base + noise) * (0.6 + params.density * 0.7)));
		heights.push(intensity);
	}

	const rows: React.ReactElement[] = [];
	for (let y = 0; y < height; y++) {
		const segs: React.ReactElement[] = [];
		const rowFromBottom = height - 1 - y;
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
			const inAvoid =
				avoid && x >= avoid.x && x < avoid.x + avoid.width && y >= avoid.y && y < avoid.y + avoid.height;
			let glyph = " ";
			let color = "";
			if (!inAvoid) {
				const totalUnits = heights[x]! * height * 8;
				const cellMax = (rowFromBottom + 1) * 8;
				const cellMin = rowFromBottom * 8;
				if (totalUnits >= cellMax) {
					glyph = PARTIALS[7]!;
				} else if (totalUnits > cellMin) {
					const frac = (totalUnits - cellMin) / 8;
					glyph = PARTIALS[Math.max(0, Math.min(7, Math.floor(frac * 8)))]!;
				}
				if (glyph !== " ") {
					const intensity = (heights[x]! * (rowFromBottom + 1)) / Math.max(1, height);
					color =
						rowFromBottom < 2
							? sampleAmber(0.35 * brightness)
							: safeHueToColor(params.hue, Math.min(0.85, intensity * brightness + 0.2), params.saturation);
				}
			}
			if (color === runColor) {
				runText += glyph;
			} else {
				flush();
				runText = glyph;
				runColor = color;
			}
		}
		flush();
		rows.push(<Box key={`row-${y}`}>{segs}</Box>);
	}

	return <Box flexDirection="column">{rows}</Box>;
}
