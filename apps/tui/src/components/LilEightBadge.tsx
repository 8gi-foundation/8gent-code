/**
 * LilEightBadge - chrome state pet for the TUI HeaderBar.
 *
 * Pure presentational component. Renders a small bordered badge containing
 * the "8" mark, the Lil Eight glyph, and the current state label. Border
 * and label color shift with state to give the TUI a sense of life without
 * any motion or side effects.
 *
 * Theme tokens only. No inline hex. No internal state.
 */

import { Box, Text } from "ink";
import React from "react";
import { t } from "../theme.js";

type LilEightState = "idle" | "thinking" | "working" | "done" | "error" | "sleep";

const stateColor: Record<LilEightState, string> = {
	idle:     t.muted,
	thinking: t.teal,
	working:  t.orange,
	done:     t.green,
	error:    t.red,
	sleep:    t.dim,
};

export function LilEightBadge({ state }: { state: LilEightState }) {
	return (
		<Box borderStyle="round" borderColor={stateColor[state]} paddingX={1} flexShrink={0}>
			<Text color={t.orange}>8</Text>
			<Text color={t.textPrimary}>▣ </Text>
			<Text color={stateColor[state]}>{state}</Text>
		</Box>
	);
}

export type { LilEightState };
