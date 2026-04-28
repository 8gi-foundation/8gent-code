/**
 * RuneDance - Glyphs from a curated alphabet shifting in place.
 *
 * Each cell holds a rune index that increments on tick. The increment is
 * gated by per-cell noise so cells advance at different rates - some
 * stutter, some race. `params.density` controls how many cells are alive
 * (vs blank); `params.distribution` controls clustering vs even spread.
 */

import { Box, Text } from "ink";
import React from "react";
import type { OperatorProps } from "./types.js";
import { sampleAmber, safeHueToColor } from "../../lib/amber-palette.js";

const ALPHABET = [
	"ᚠ",
	"ᚢ",
	"ᚦ",
	"ᚨ",
	"ᚱ",
	"ᚲ",
	"ᚷ",
	"ᚹ",
	"ᚺ",
	"ᚾ",
	"ᛁ",
	"ᛃ",
	"ᛇ",
	"ᛈ",
	"ᛉ",
	"ᛊ",
	"ᛏ",
	"ᛒ",
	"ᛖ",
	"ᛗ",
	"ᛚ",
	"ᛜ",
	"ᛞ",
	"ᛟ",
	"┃",
	"━",
	"╋",
	"┏",
	"┓",
	"┛",
	"┗",
	"╱",
	"╲",
	"◇",
	"◆",
	"○",
	"●",
	"⌬",
	"⊛",
	"⊕",
];

function cellHash(x: number, y: number, distribution: number): number {
	const a = Math.imul(x | 0, 374761393);
	const b = Math.imul(y | 0, 668265263);
	const c = Math.imul((a ^ b) >>> 0, 1274126177);
	const v = ((c ^ (c >>> 16)) >>> 0) / 4294967296;
	// distribution=0 -> uniform, distribution=1 -> clusters via softening
	return distribution > 0.5 ? Math.pow(v, 1.5 - distribution) : v;
}

export function RuneDance({ width, height, params, tick, brightness, avoid }: OperatorProps): React.ReactElement {
	const aliveThreshold = 1 - params.density * 0.8;
	const speed = 0.2 + params.speed * 0.7;
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
			const inAvoid =
				avoid && x >= avoid.x && x < avoid.x + avoid.width && y >= avoid.y && y < avoid.y + avoid.height;
			let glyph = " ";
			let color = "";
			if (!inAvoid) {
				const h = cellHash(x, y, params.distribution);
				if (h > aliveThreshold) {
					const cellSpeed = 1 + Math.floor(h * 8 * (1 - params.noise) + params.noise * 4);
					const idx = (Math.floor(tick * speed) + Math.floor(h * 1000)) % cellSpeed === 0
						? (Math.floor(tick * speed) + Math.floor(h * ALPHABET.length * 7)) % ALPHABET.length
						: (Math.floor(tick * speed * 0.5) + Math.floor(h * ALPHABET.length * 3)) % ALPHABET.length;
					glyph = ALPHABET[idx]!;
					const isCool = h > 0.85;
					color = isCool
						? safeHueToColor(0.85, 0.5 * brightness, params.saturation * 0.7)
						: sampleAmber(Math.min(0.95, (0.4 + h * 0.6) * brightness));
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
