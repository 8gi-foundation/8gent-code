/**
 * HeaderBar - top-of-frame brand row.
 *
 * V2 chrome only: BrandPill on the left; workspace path + branch + sync
 * in the middle; command-palette hint, MIC indicator, [ASK] chip,
 * LOCAL-FIRST chip, session clock, and LilEightBadge on the right.
 *
 * Pure presentational. Theme tokens only. No inline hex.
 */

import { Box, Text } from "ink";
import React from "react";
import { t } from "../theme.js";
import { LilEightBadge, type LilEightState } from "./LilEightBadge.js";

const ui = {
	cream:      t.textPrimary,
	muted:      t.textTertiary,
	dim:        t.textDim,
	orange:     t.orange,
	teal:       t.teal,
	pillBorder: t.orange,
} as const;

interface HeaderBarProps {
	updateAvailable?: { latest: string; current: string } | null;
	workspacePath: string;
	branch: string;
	/** "ahead 1", "behind 2", "in sync", etc. */
	syncStatus: string;
	micOn: boolean;
	approvalPending: boolean;
	localFirst: boolean;
	sessionTime: string;
	lilEightState: LilEightState;
}

export function HeaderBar({
	updateAvailable,
	workspacePath,
	branch,
	syncStatus,
	micOn,
	approvalPending,
	localFirst,
	sessionTime,
	lilEightState,
}: HeaderBarProps) {
	return (
		<Box width="100%" justifyContent="space-between" alignItems="center" flexShrink={0}>
			<BrandPill updateAvailable={updateAvailable} />

			<Box flexShrink={1} minWidth={0} paddingX={1}>
				<Text color={ui.muted} wrap="truncate-middle">
					{workspacePath}
				</Text>
				<Text color={ui.dim}>  </Text>
				<Text color={ui.teal}>⎇ </Text>
				<Text color={ui.orange} wrap="truncate-end">
					{branch}
				</Text>
				<Text color={ui.dim}>  </Text>
				<Text color={ui.muted}>{syncStatus}</Text>
			</Box>

			<Box flexShrink={0}>
				<Text color={ui.muted}>⌘K</Text>
				<Text color={ui.dim}>  </Text>
				<Text color={micOn ? t.red : ui.dim}>{micOn ? "● MIC" : "○ MIC"}</Text>
				<Text color={ui.dim}>  </Text>
				{approvalPending ? (
					<>
						<Text color={t.orange} bold>[ASK]</Text>
						<Text color={ui.dim}>  </Text>
					</>
				) : null}
				<Text color={localFirst ? t.green : ui.dim}>LOCAL-FIRST</Text>
				<Text color={ui.dim}>  </Text>
				<Text color={ui.muted}>{sessionTime}</Text>
				<Text color={ui.dim}>  </Text>
				<LilEightBadge state={lilEightState} />
			</Box>
		</Box>
	);
}

function BrandPill({
	updateAvailable,
}: {
	updateAvailable?: { latest: string; current: string } | null;
}) {
	return (
		<Box borderStyle="round" borderColor={ui.pillBorder} paddingX={1} flexShrink={0}>
			<BrandWord />
			<Text color={ui.muted}> Code</Text>
			<Text color={ui.orange} bold>.</Text>
			<Text color={ui.dim}> </Text>
			<Text color={ui.dim}>│</Text>
			<Text color={ui.muted}> The Infinite </Text>
			<Text color={ui.teal}>Gentleman</Text>
			{updateAvailable ? (
				<>
					<Text color={ui.dim}>  │ </Text>
					<Text color={ui.orange}>↑ v{updateAvailable.latest}</Text>
				</>
			) : null}
		</Box>
	);
}

function BrandWord() {
	return (
		<Box flexShrink={0}>
			<Text color={ui.orange} bold>8</Text>
			<Text color={ui.cream} bold>gent</Text>
		</Box>
	);
}

export type { HeaderBarProps };
