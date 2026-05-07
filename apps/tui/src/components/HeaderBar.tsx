/**
 * HeaderBar - top-of-frame brand row.
 *
 * Two render modes, controlled by presence of V2 props:
 *
 *   1. Legacy (default): rounded BrandPill on the left, `^T:new ^W:close`
 *      shortcuts on the right. Identical to pre-V2 main. This is what
 *      app.tsx renders when 8GENT_TUI_V2 is unset/0.
 *
 *   2. V2 chrome: BrandPill on the left; workspace path + branch + sync
 *      in the middle; command-palette hint, MIC indicator, [ASK] chip,
 *      LOCAL-FIRST chip, session clock, and LilEightBadge on the right.
 *      app.tsx renders this when 8GENT_TUI_V2=1.
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

interface HeaderBarV2Props {
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

interface HeaderBarProps {
	updateAvailable?: { latest: string; current: string } | null;
	/** When provided, renders the V2 three-zone chrome row. */
	v2?: HeaderBarV2Props;
}

export function HeaderBar({ updateAvailable, v2 }: HeaderBarProps) {
	if (v2) {
		return <HeaderBarV2 updateAvailable={updateAvailable} v2={v2} />;
	}
	return (
		<Box width="100%" justifyContent="space-between" alignItems="center" flexShrink={0}>
			<BrandPill updateAvailable={updateAvailable} />
			<Box flexShrink={0}>
				<Text color={ui.muted}>^T:new  ^W:close</Text>
			</Box>
		</Box>
	);
}

function HeaderBarV2({
	updateAvailable,
	v2,
}: {
	updateAvailable?: { latest: string; current: string } | null;
	v2: HeaderBarV2Props;
}) {
	return (
		<Box width="100%" justifyContent="space-between" alignItems="center" flexShrink={0}>
			<BrandPill updateAvailable={updateAvailable} />

			<Box flexShrink={1} minWidth={0} paddingX={1}>
				<Text color={ui.muted} wrap="truncate-middle">
					{v2.workspacePath}
				</Text>
				<Text color={ui.dim}>  </Text>
				<Text color={ui.teal}>⎇ </Text>
				<Text color={ui.orange} wrap="truncate-end">
					{v2.branch}
				</Text>
				<Text color={ui.dim}>  </Text>
				<Text color={ui.muted}>{v2.syncStatus}</Text>
			</Box>

			<Box flexShrink={0}>
				<Text color={ui.muted}>⌘K</Text>
				<Text color={ui.dim}>  </Text>
				<Text color={v2.micOn ? t.red : ui.dim}>{v2.micOn ? "● MIC" : "○ MIC"}</Text>
				<Text color={ui.dim}>  </Text>
				{v2.approvalPending ? (
					<>
						<Text color={t.orange} bold>[ASK]</Text>
						<Text color={ui.dim}>  </Text>
					</>
				) : null}
				<Text color={v2.localFirst ? t.green : ui.dim}>LOCAL-FIRST</Text>
				<Text color={ui.dim}>  </Text>
				<Text color={ui.muted}>{v2.sessionTime}</Text>
				<Text color={ui.dim}>  </Text>
				<LilEightBadge state={v2.lilEightState} />
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

export type { HeaderBarProps, HeaderBarV2Props };
