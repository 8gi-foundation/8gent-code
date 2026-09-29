/**
 * ToolTrail - one compact line per tool call in a turn.
 *
 *   ✓ write_file deck/outline.md
 *   ⊘ run_command ls deck && wc -l deck/deck.md (blocked)
 *   ✓ read_file ×5 (packages/decide/…)
 *
 * Rows come from lib/tool-trail.ts (collapse + width-fit), so every line is
 * pre-truncated to `width` and can never wrap or push the layout sideways.
 *
 * Motion: when several rows arrive in one update (parallel calls finishing
 * together), they land one after another, 80 ms apart and within 300 ms in
 * all (lib/motion.ts). Rows already on screen never disappear, a single new
 * row shows at once, and a trail that mounts with rows shows them all.
 */

import { Box, Text } from "ink";
import { useEffect, useRef, useState } from "react";
import { motionEnabled, staggerFor } from "../lib/motion.js";
import { glyphs } from "../lib/term-caps.js";
import {
	type ToolTrailEntry,
	type TrailStatus,
	collapseTrail,
	formatTrailRow,
} from "../lib/tool-trail.js";
import { t } from "../theme.js";

// Read at render time: `t` follows the live light/dark theme.
function iconColor(status: TrailStatus): string {
	return status === "ok" ? t.green : status === "fail" ? t.red : t.orange;
}

/**
 * How many of `total` rows to draw. A batch of new rows lands one at a time;
 * the count only lags `total` for one short burst, and never drops below
 * what was already on screen.
 */
export function useLandingRows(total: number, animate: boolean): number {
	const [shown, setShown] = useState(total);
	const shownRef = useRef(total);
	shownRef.current = shown;
	// The total a burst is landing towards, or null when no burst runs.
	const landingRef = useRef<number | null>(null);

	useEffect(() => {
		const from = shownRef.current;
		if (total <= from + 1 || !motionEnabled(animate)) {
			landingRef.current = null;
			setShown(total);
			return;
		}
		landingRef.current = total;
		const step = staggerFor(total - from);
		let n = from + 1;
		setShown(n);
		const id = setInterval(() => {
			n += 1;
			setShown(Math.min(total, n));
			if (n >= total) {
				landingRef.current = null;
				clearInterval(id);
			}
		}, step);
		return () => clearInterval(id);
	}, [total, animate]);

	// A single new row, or a shrink, shows at once; a batch holds back until
	// the effect starts landing it, so nothing flashes for a frame.
	if (landingRef.current === total) return Math.min(shown, total);
	if (total <= shown + 1) return total;
	return shown;
}

export function ToolTrail({
	entries,
	width,
	maxRows,
	animate = true,
}: {
	entries: ToolTrailEntry[];
	width: number;
	/** Row ceiling for this turn; the oldest calls fold into a summary row. */
	maxRows?: number;
	/** False (Ctrl+A) shows new rows at once. */
	animate?: boolean;
}) {
	const rows = collapseTrail(entries, maxRows);
	const visible = useLandingRows(rows.length, animate);
	if (rows.length === 0) return null;
	return (
		<Box flexDirection="column" flexShrink={0}>
			{rows.slice(0, visible).map((row, i) => {
				const { text } = formatTrailRow(row, width);
				// Same one-column icon, ASCII on terminals that cannot draw it.
				const g = glyphs();
				const icon = row.status === "ok" ? g.ok : row.status === "fail" ? g.fail : g.blocked;
				return (
					// Rows are positional within one turn and never reorder.
					// react-doctor-disable-next-line react-doctor/no-array-index-as-key
					<Box key={i} width={width}>
						<Text color={iconColor(row.status)}>{icon}</Text>
						<Text color={row.status === "ok" ? t.muted : t.textPrimary} wrap="truncate-end">
							{` ${text}`}
						</Text>
					</Box>
				);
			})}
		</Box>
	);
}

/** Rows a trail occupies, for MessageList's row-budget math. */
export function toolTrailRows(entries: ToolTrailEntry[], maxRows?: number): number {
	return entries.length === 0 ? 0 : collapseTrail(entries, maxRows).length;
}
