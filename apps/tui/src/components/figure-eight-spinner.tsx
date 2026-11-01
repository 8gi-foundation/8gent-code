/**
 * The spinner shown beside the working verb ("Thinking", "Reasoning",
 * "Running <tool>"). It traces a figure of eight; see lib/figure-eight.ts for
 * the path and why it is not the stock braille square.
 */

import { Text } from "ink";
import React, { useEffect, useState } from "react";
import {
	FIGURE_EIGHT_INTERVAL_MS,
	FIGURE_EIGHT_STILL,
	figureEightFrame,
} from "../lib/figure-eight.js";

interface FigureEightProps {
	/** False holds a single frame, for reduced motion or a quiet terminal. */
	animate?: boolean;
	/** Passed through to Ink. Never pass gray, white or black (TUI colour rules). */
	color?: string;
}

export function FigureEight({ animate = true, color }: FigureEightProps) {
	const [tick, setTick] = useState(0);

	useEffect(() => {
		if (!animate) return;
		const timer = setInterval(() => {
			setTick((previous) => previous + 1);
		}, FIGURE_EIGHT_INTERVAL_MS);
		return () => clearInterval(timer);
	}, [animate]);

	const glyph = animate ? figureEightFrame(tick) : FIGURE_EIGHT_STILL;

	return color ? <Text color={color}>{glyph}</Text> : <Text>{glyph}</Text>;
}
