/**
 * MetricRow - shared label/value row for ContextRail and ActivityRail.
 *
 * Fixed-width label column + flex-grow value column. Eliminates the wrong-side
 * clipping (e.g. `ranch`, `isk`) that the old space-between layout produced
 * when Ink tried to truncate from both sides at narrow widths.
 *
 * Rules:
 *   - Label box: width={10}, flexShrink=0, truncate-end. Stable column.
 *   - Value box: flexGrow=1, minWidth=0, truncate-end. Takes remaining space.
 *   - Use TruncatedValue (truncate-middle) inside the value column for long
 *     identifier strings like provider/model names where both ends matter.
 *
 * Theme tokens only. No inline hex.
 */

import { Box, Text } from "ink";
import React from "react";
import { t } from "../theme.js";

export function MetricRow({
	label,
	value,
	color = t.textSecondary,
}: {
	label: string;
	value: string;
	color?: string;
}) {
	return (
		<Box width="100%" overflow="hidden">
			<Box width={9} flexShrink={0}>
				<Text color={t.dim} wrap="truncate-end">{label}</Text>
			</Box>
			<Box flexGrow={1} minWidth={0}>
				<Text color={color} wrap="truncate-end">{value}</Text>
			</Box>
		</Box>
	);
}

export function TruncatedValue({
	value,
	color = t.textSecondary,
}: {
	value: string;
	color?: string;
}) {
	return <Text color={color} wrap="truncate-middle">{value}</Text>;
}

