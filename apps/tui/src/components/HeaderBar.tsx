/**
 * HeaderBar - top-of-frame brand row.
 *
 * V2 chrome only: BrandPill on the left; workspace path + branch + sync
 * in the middle; ^P palette hint, MIC indicator, [ASK] chip,
 * LOCAL-FIRST chip, session clock, and LilEightBadge on the right.
 *
 * Pure presentational. Theme tokens only. No inline hex.
 */

import { Box, Text } from "ink";
import React from "react";
import { t } from "../theme.js";
import { LilEightBadge, type LilEightState } from "./LilEightBadge.js";

// Pre-truncate header strings so the chrome row never wraps to a second
// line. Once the middle Box is allowed to wrap, the whole header collapses.
function truncateMiddle(s: string, max: number): string {
	if (s.length <= max) return s;
	const half = Math.max(1, Math.floor((max - 1) / 2));
	return `${s.slice(0, half)}…${s.slice(s.length - half)}`;
}

function truncateEnd(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, Math.max(1, max - 1))}…`;
}

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
	/** Current package version (e.g. "0.17.0"). Rendered in the brand pill so you always know what build you are on. */
	version?: string;
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
	version,
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
		<Box width="100%" justifyContent="space-between" alignItems="center" flexShrink={0} overflow="hidden">
			<Box width={48} flexShrink={0}>
				<BrandPill updateAvailable={updateAvailable} version={version} />
			</Box>

			<Box flexGrow={1} minWidth={0} paddingX={1} justifyContent="center" overflow="hidden">
				<Text color={ui.muted} wrap="truncate-middle">{truncateMiddle(workspacePath, 24)}</Text>
				<Text color={ui.teal}> ⎇ </Text>
				<Text color={ui.orange}>{truncateEnd(branch, 14)}</Text>
				<Text color={ui.dim}> </Text>
				<Text color={ui.muted}>{truncateEnd(syncStatus, 10)}</Text>
			</Box>

			<Box width={36} flexShrink={0} justifyContent="flex-end">
				<Text color={ui.dim}>^P</Text>
				<Text color={ui.muted}> palette  </Text>
				<Text color={micOn ? t.red : ui.dim}>{micOn ? "● MIC" : "○ MIC"}</Text>
				<Text color={ui.dim}>  </Text>
				{approvalPending ? (
					<>
						<Text color={t.orange} bold>[ASK]</Text>
						<Text color={ui.dim}> </Text>
					</>
				) : null}
				<Text color={localFirst ? t.green : ui.dim}>LOCAL</Text>
				<Text color={ui.dim}> </Text>
				<Text color={ui.muted}>{sessionTime}</Text>
				<Text color={ui.dim}> </Text>
				<LilEightBadge state={lilEightState} />
			</Box>
		</Box>
	);
}

function BrandPill({
	updateAvailable,
	version,
}: {
	updateAvailable?: { latest: string; current: string } | null;
	version?: string;
}) {
	return (
		<Box borderStyle="round" borderColor={ui.pillBorder} paddingX={1} flexShrink={0}>
			<BrandWord />
			<Text color={ui.muted}> Code</Text>
			<Text color={ui.orange} bold>.</Text>
			{version ? (
				<>
					<Text color={ui.dim}> </Text>
					<Text color={ui.muted}>v{version}</Text>
				</>
			) : null}
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
