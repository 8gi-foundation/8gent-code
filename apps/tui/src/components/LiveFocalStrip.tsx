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
	/** When the agent is running unattended (auto-approve all), the focal
	 *  strip swaps the mode label for "Autonomous" so the operator instantly
	 *  knows manual approvals are off. Border also stays teal regardless of
	 *  approvalPending because nothing is actually waiting on the user. */
	autonomous?: boolean;
	/** True when the agent is actively processing. Drives the NOW vs READY
	 *  state label - we don't shout "NOW" at an idle TUI. */
	isProcessing?: boolean;
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
	autonomous = false,
	isProcessing = false,
}: LiveFocalStripProps) {
	const displayMode = autonomous ? "Autonomous" : mode;
	const showApprovalBorder = approvalPending && !autonomous;
	const stateLabel = isProcessing ? "NOW" : "READY";
	return (
		<Box
			width="100%"
			minHeight={isProcessing ? 3 : 1}
			borderStyle={isProcessing ? "round" : "single"}
			borderColor={showApprovalBorder ? t.orange : isProcessing ? t.teal : t.border}
			paddingX={1}
			justifyContent="space-between"
			flexShrink={0}
			overflow="hidden"
		>
			<Box width={22} flexShrink={0}>
				<Text color={isProcessing ? t.teal : t.muted}>◆ {stateLabel} </Text>
				<Text color={t.textPrimary} bold wrap="truncate-end">
					{displayMode}
				</Text>
			</Box>

			<Box flexGrow={1} minWidth={0} paddingX={1}>
				<Text color={t.textSecondary} wrap="truncate-end">
					{isProcessing ? activeStep : "idle"}
				</Text>
			</Box>

			<Box width={42} flexShrink={0} justifyContent="flex-end">
				<Text color={t.steel} wrap="truncate-middle">{route}</Text>
				<Text color={t.dim}> ctx </Text>
				<Text color={t.steel}>{meter(contextPct)}</Text>
				<Text color={t.dim}> {tokens}</Text>
			</Box>
		</Box>
	);
}

export type { LiveFocalStripProps };
