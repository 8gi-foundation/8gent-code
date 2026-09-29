/**
 * ToolTrail - one compact line per tool call in a turn.
 *
 *   ✓ write_file deck/outline.md
 *   ⊘ run_command ls deck && wc -l deck/deck.md (blocked)
 *   ✓ read_file ×5 (packages/decide/…)
 *
 * Rows come from lib/tool-trail.ts (collapse + width-fit), so every line is
 * pre-truncated to `width` and can never wrap or push the layout sideways.
 */

import { Box, Text } from "ink";
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

export function ToolTrail({
	entries,
	width,
	maxRows,
}: {
	entries: ToolTrailEntry[];
	width: number;
	/** Row ceiling for this turn; the oldest calls fold into a summary row. */
	maxRows?: number;
}) {
	const rows = collapseTrail(entries, maxRows);
	if (rows.length === 0) return null;
	return (
		<Box flexDirection="column" flexShrink={0}>
			{rows.map((row, i) => {
				const { icon, text } = formatTrailRow(row, width);
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
