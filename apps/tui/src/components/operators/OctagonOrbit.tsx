/**
 * OctagonOrbit - Concentric octagons traced with box-drawing glyphs.
 *
 * The brand is "8gent" - so the visualiser carries an 8-sided shape. We
 * pre-compute a small set of octagonal rings inside the available canvas
 * and animate them by phase-shifting which segments are visible. The
 * `rotation` and `speed` params drive the animation.
 *
 * Terminals can't actually rotate, so "rotation" is achieved by walking
 * a phase pointer around the perimeter of each ring and lighting up
 * segments around that pointer.
 */

import { Box, Text } from "ink";
import React from "react";
import type { OperatorProps } from "./types.js";
import { sampleAmber, safeHueToColor } from "../../lib/amber-palette.js";

interface RingPoint {
	x: number;
	y: number;
	glyph: string;
}

function buildOctagon(cx: number, cy: number, w: number, h: number): RingPoint[] {
	if (w < 3 || h < 3) return [];
	const left = Math.floor(cx - w / 2);
	const right = Math.floor(cx + w / 2);
	const top = Math.floor(cy - h / 2);
	const bottom = Math.floor(cy + h / 2);
	const cornerH = Math.max(1, Math.floor(w * 0.2));
	const cornerV = Math.max(1, Math.floor(h * 0.25));
	const pts: RingPoint[] = [];
	// Top edge
	for (let x = left + cornerH; x <= right - cornerH; x++) pts.push({ x, y: top, glyph: "─" });
	// Top-right diagonal
	for (let i = 1; i <= Math.min(cornerH, cornerV); i++) {
		pts.push({ x: right - cornerH + i, y: top + i, glyph: "╲" });
	}
	// Right edge
	for (let y = top + cornerV; y <= bottom - cornerV; y++) pts.push({ x: right, y, glyph: "│" });
	// Bottom-right diagonal
	for (let i = 1; i <= Math.min(cornerH, cornerV); i++) {
		pts.push({ x: right - i, y: bottom - cornerV + i, glyph: "╱" });
	}
	// Bottom edge
	for (let x = right - cornerH; x >= left + cornerH; x--) pts.push({ x, y: bottom, glyph: "─" });
	// Bottom-left diagonal
	for (let i = 1; i <= Math.min(cornerH, cornerV); i++) {
		pts.push({ x: left + cornerH - i, y: bottom - i, glyph: "╲" });
	}
	// Left edge
	for (let y = bottom - cornerV; y >= top + cornerV; y--) pts.push({ x: left, y, glyph: "│" });
	// Top-left diagonal
	for (let i = 1; i <= Math.min(cornerH, cornerV); i++) {
		pts.push({ x: left + i, y: top + cornerV - i, glyph: "╱" });
	}
	return pts;
}

export function OctagonOrbit({ width, height, params, tick, brightness, avoid }: OperatorProps): React.ReactElement {
	const cx = Math.floor(width / 2);
	const cy = Math.floor(height / 2);
	const ringCount = Math.max(2, Math.round(2 + params.size * 3));
	const minW = 5;
	const minH = 3;
	const maxW = Math.max(minW, width - 2);
	const maxH = Math.max(minH, height - 1);

	const grid: Array<Array<{ glyph: string; color: string }>> = [];
	for (let y = 0; y < height; y++) {
		grid.push(Array.from({ length: width }, () => ({ glyph: " ", color: "" })));
	}

	for (let r = 0; r < ringCount; r++) {
		const frac = (r + 1) / ringCount;
		const w = Math.round(minW + (maxW - minW) * frac);
		const h = Math.round(minH + (maxH - minH) * frac);
		const pts = buildOctagon(cx, cy, w, h);
		if (!pts.length) continue;
		const speed = 0.15 + params.speed * 0.5 + params.rotation * 0.3;
		const direction = r % 2 === 0 ? 1 : -1;
		const phase = (tick * speed * direction) % pts.length;
		const arc = Math.max(2, Math.round(pts.length * (0.15 + params.density * 0.35)));
		for (let i = 0; i < pts.length; i++) {
			const dist = Math.min(
				Math.abs(i - phase),
				Math.abs(i - phase - pts.length),
				Math.abs(i - phase + pts.length),
			);
			const within = dist <= arc;
			const intensity = within ? Math.max(0.15, 1 - dist / arc) : 0.1;
			const p = pts[i]!;
			if (p.x < 0 || p.x >= width || p.y < 0 || p.y >= height) continue;
			if (
				avoid &&
				p.x >= avoid.x &&
				p.x < avoid.x + avoid.width &&
				p.y >= avoid.y &&
				p.y < avoid.y + avoid.height
			) {
				continue;
			}
			const color =
				r === 0
					? sampleAmber(intensity * brightness)
					: safeHueToColor(params.hue, intensity * brightness, params.saturation);
			grid[p.y]![p.x] = { glyph: p.glyph, color };
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
