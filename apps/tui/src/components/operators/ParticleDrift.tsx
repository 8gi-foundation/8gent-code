/**
 * ParticleDrift - N points following a flow-field.
 *
 * Particle count = round(8 + density * 16). Each particle holds an angle
 * sampled from a 2D flow field, advances per tick, and bounces off bounds.
 * Trails are drawn by also marking the previous 1-2 cells with dimmer
 * glyphs. Colour drawn from the amber-safe hue ramp.
 */

import { Box, Text } from "ink";
import React, { useRef } from "react";
import type { OperatorProps } from "./types.js";
import { safeHueToColor, sampleAmber } from "../../lib/amber-palette.js";

interface Particle {
	x: number;
	y: number;
	vx: number;
	vy: number;
	prev: Array<[number, number]>;
}

const HEAD_GLYPHS = ["✦", "✧", "*", "·"];

function flowAngle(x: number, y: number, t: number, noiseAmt: number): number {
	const a = Math.sin(x * 0.3 + t * 0.05) + Math.cos(y * 0.4 - t * 0.04);
	const jitter = (Math.sin(x * 7 + y * 13 + t * 0.1) * 0.5) * noiseAmt;
	return a * Math.PI + jitter * Math.PI;
}

export function ParticleDrift({ width, height, params, tick, brightness, avoid }: OperatorProps): React.ReactElement {
	const ref = useRef<{ particles: Particle[] | null; lastTick: number; lastCount: number }>({
		particles: null,
		lastTick: -1,
		lastCount: 0,
	});

	const count = Math.max(4, Math.round(8 + params.density * 16));
	if (!ref.current.particles || ref.current.lastCount !== count) {
		const seeded: Particle[] = [];
		for (let i = 0; i < count; i++) {
			seeded.push({
				x: ((i * 9301 + 49297) % 233280) / 233280 * width,
				y: ((i * 18097 + 7919) % 233280) / 233280 * height,
				vx: 0,
				vy: 0,
				prev: [],
			});
		}
		ref.current.particles = seeded;
		ref.current.lastCount = count;
	}

	if (ref.current.lastTick !== tick) {
		const speedFactor = 0.2 + params.speed * 0.7;
		for (const p of ref.current.particles) {
			const ang = flowAngle(p.x, p.y, tick, params.noise);
			p.vx = Math.cos(ang) * speedFactor;
			p.vy = Math.sin(ang) * speedFactor * 0.6;
			p.prev.unshift([p.x, p.y]);
			if (p.prev.length > 2) p.prev.length = 2;
			p.x += p.vx;
			p.y += p.vy;
			if (p.x < 0) {
				p.x = 0;
				p.vx = -p.vx;
			}
			if (p.x >= width) {
				p.x = width - 1;
				p.vx = -p.vx;
			}
			if (p.y < 0) {
				p.y = 0;
				p.vy = -p.vy;
			}
			if (p.y >= height) {
				p.y = height - 1;
				p.vy = -p.vy;
			}
		}
		ref.current.lastTick = tick;
	}

	const grid: Array<Array<{ glyph: string; color: string }>> = [];
	for (let y = 0; y < height; y++) {
		grid.push(Array.from({ length: width }, () => ({ glyph: " ", color: "" })));
	}
	for (const p of ref.current.particles) {
		const px = Math.floor(p.x);
		const py = Math.floor(p.y);
		// Trails first (dimmer)
		p.prev.forEach(([tx, ty], i) => {
			const ix = Math.floor(tx);
			const iy = Math.floor(ty);
			if (ix < 0 || ix >= width || iy < 0 || iy >= height) return;
			const g = i === 0 ? HEAD_GLYPHS[2]! : HEAD_GLYPHS[3]!;
			grid[iy]![ix] = {
				glyph: g,
				color: sampleAmber(0.3 * brightness),
			};
		});
		// Head
		if (px >= 0 && px < width && py >= 0 && py < height) {
			grid[py]![px] = {
				glyph: HEAD_GLYPHS[0]!,
				color: safeHueToColor(params.hue, 0.7 * brightness, params.saturation),
			};
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
			if (avoid && x >= avoid.x && x < avoid.x + avoid.width && y >= avoid.y && y < avoid.y + avoid.height) {
				flush();
				segs.push(<Text key={`s${segIdx++}`}> </Text>);
				continue;
			}
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
