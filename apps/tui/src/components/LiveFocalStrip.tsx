/**
 * LiveFocalStrip - single horizontal strip above the message list that
 * always answers "what is happening NOW?"
 *
 * One canonical pulse: mode + active step on the left, route + context
 * meter + token count on the right. Border is teal by default and flips
 * to orange when an approval is pending so the eye lands on it without
 * a second glance.
 *
 * Pure presentational: no state, no effects, no side-channels. Caller
 * owns every value.
 *
 * Per TUI North Star v2 PRD snippet 1 (issue #2335).
 */

import { Box, Text } from "ink";
import React from "react";
import { t } from "../theme.js";

type Mode = "Planning" | "Researching" | "Implementing" | "Testing" | "Debugging";

interface LiveFocalStripProps {
	mode: Mode;
	activeStep: string;
	route: string;
	tokens: string;
	contextPct: number;
	approvalPending?: boolean;
}

/**
 * Render a fixed-width unicode meter from a percent value. Inputs over
 * 100 or below 0 are clamped so the strip never overflows or underflows.
 */
export function meter(percent: number, width = 10): string {
	const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
	return "█".repeat(filled) + "░".repeat(width - filled);
}

export function LiveFocalStrip({
	mode,
	activeStep,
	route,
	tokens,
	contextPct,
	approvalPending = false,
}: LiveFocalStripProps) {
	return (
		<Box
			width="100%"
			borderStyle="round"
			borderColor={approvalPending ? t.orange : t.teal}
			paddingX={1}
			justifyContent="space-between"
			flexShrink={0}
			overflow="hidden"
		>
			<Box minWidth={0}>
				<Text color={t.teal}>◆ NOW </Text>
				<Text color={t.textPrimary} bold wrap="truncate-end">
					{mode}
				</Text>
				<Text color={t.muted}> / </Text>
				<Text color={t.textSecondary} wrap="truncate-end">
					{activeStep}
				</Text>
			</Box>

			<Box flexShrink={0}>
				<Text color={t.steel}>{route}</Text>
				<Text color={t.dim}>  ctx </Text>
				<Text color={t.steel}>{meter(contextPct)}</Text>
				<Text color={t.dim}>  {tokens}</Text>
			</Box>
		</Box>
	);
}

export type { Mode, LiveFocalStripProps };
