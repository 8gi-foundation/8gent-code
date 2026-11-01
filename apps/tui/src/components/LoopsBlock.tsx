/**
 * LOOPS block for the side panel (#5062, slice 1 of #5067): the top five loops
 * by urgency, a glyph, a name and a one-word state. It draws only when the
 * rail has spare rows, and it subscribes to the Control store only then, so a
 * short or narrow terminal pays nothing and shows nothing.
 *
 * `rows` is a test seam: when given, the store is not touched.
 */
import { Box, Text } from "ink";
import React from "react";
import { useControlSnapshot } from "../hooks/useControlSnapshot.js";
import { type LoopRow, type LoopState, STATE_ORDER } from "../lib/control-state.js";
import { t } from "../theme.js";

/** Rows of the rail the LOOPS block may use, or 0 when it must stay hidden. */
export function loopsBlockRows(spare: number): number {
	// Two rows of chrome (gap and heading) plus at least one loop.
	return spare >= 3 ? Math.min(5, spare - 2) : 0;
}

const WORD: Record<LoopState, string> = {
	"waiting-on-you": "you",
	running: "running",
	queued: "queued",
	stalled: "stalled",
	done: "done",
};
const GLYPH: Record<LoopState, string> = {
	"waiting-on-you": "!",
	running: "●",
	queued: "◐",
	stalled: "○",
	done: "●",
};
const COLOR: Record<LoopState, string> = {
	"waiting-on-you": t.orange,
	running: t.green,
	queued: t.teal,
	stalled: t.red,
	done: t.textTertiary,
};

export function topLoops(rows: readonly LoopRow[], max: number): LoopRow[] {
	return rows.filter((r) => STATE_ORDER.includes(r.state)).slice(0, max);
}

export function LoopsBlock({ spare, rows }: { spare: number; rows?: readonly LoopRow[] }) {
	const room = loopsBlockRows(spare);
	const snap = useControlSnapshot(room > 0 && rows === undefined);
	if (room === 0) return null;
	const shown = topLoops(rows ?? snap?.rows ?? [], room);
	if (shown.length === 0) return null;
	return (
		<Box flexDirection="column" marginTop={1} width="100%" flexShrink={0}>
			<Box flexShrink={0}>
				<Text color={t.heading} bold>
					LOOPS
				</Text>
			</Box>
			{shown.map((r) => (
				<Box key={`${r.kind}:${r.name}`} width="100%" flexShrink={0} justifyContent="space-between">
					<Box flexGrow={1} minWidth={0}>
						<Text color={COLOR[r.state]} wrap="truncate-end">
							{`${GLYPH[r.state]} ${r.name}`}
						</Text>
					</Box>
					<Box flexShrink={0} marginLeft={1}>
						<Text color={t.textTertiary}>{WORD[r.state]}</Text>
					</Box>
				</Box>
			))}
		</Box>
	);
}
