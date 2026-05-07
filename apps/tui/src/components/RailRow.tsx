/**
 * RailRow - shared label/value row for ContextRail and ActivityRail.
 *
 * One pattern, two rails. Eliminates the inline label-value collisions that
 * caused visible bugs like `mainch`, `ASKroval`, `MEMORYrouter` where
 * adjacent Text nodes ran together at narrow widths.
 *
 * Rules:
 *   - justifyContent="space-between" pins label left, value right.
 *   - width="100%" so the row fills its parent rail column.
 *   - overflow="hidden" prevents either side from leaking into siblings.
 *   - Both sides use wrap="truncate-end" so long branches and provider
 *     names truncate cleanly instead of wrapping into the next line.
 *
 * Theme tokens only. No inline hex.
 */

import { Box, Text } from "ink";
import React from "react";
import { t } from "../theme.js";

export function RailRow({
	label,
	value,
	color = t.textSecondary,
}: {
	label: string;
	value: string;
	color?: string;
}) {
	return (
		<Box justifyContent="space-between" width="100%" overflow="hidden">
			<Text color={t.dim} wrap="truncate-end">{label}</Text>
			<Text color={color} wrap="truncate-end">{value}</Text>
		</Box>
	);
}
