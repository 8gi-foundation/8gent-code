/**
 * The spinner shown beside the working verb ("Thinking", "Reasoning",
 * "Running <tool>"). It traces a figure of eight; see lib/figure-eight.ts for
 * the path and why it is not the stock braille square.
 */

import { Text } from "ink";
import React, { useSyncExternalStore } from "react";
import { FIGURE_EIGHT_STILL, figureEightFrame } from "../lib/figure-eight.js";
import { spinnerClockTick, subscribeSpinnerClock } from "../lib/spinner-clock.js";

const noSubscribe = () => () => {};
const frozenTick = () => 0;

interface FigureEightProps {
	/** False holds a single frame, for reduced motion or a quiet terminal. */
	animate?: boolean;
	/** Passed through to Ink. Never pass gray, white or black (TUI colour rules). */
	color?: string;
}

export function FigureEight({ animate = true, color }: FigureEightProps) {
	// Held spinners subscribe to nothing, so they cost no timer and no repaint.
	const tick = useSyncExternalStore(
		animate ? subscribeSpinnerClock : noSubscribe,
		animate ? spinnerClockTick : frozenTick,
	);

	const glyph = animate ? figureEightFrame(tick) : FIGURE_EIGHT_STILL;

	return color ? <Text color={color}>{glyph}</Text> : <Text>{glyph}</Text>;
}
