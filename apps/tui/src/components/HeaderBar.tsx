/**
 * HeaderBar - top-of-frame brand row.
 *
 * V2 chrome only: BrandPill on the left; workspace path + branch + sync
 * in the middle; ^P palette hint, MIC indicator, [ASK] chip,
 * LOCAL-FIRST chip, session clock, and LilEightBadge on the right.
 *
 * The row must never wrap. The pill and the right-hand cluster are sized
 * by their content and never shrink; the middle segment is fitted to the
 * columns left over by `fitHeaderMiddle`, which gives the branch name
 * priority over the tail of the workspace path. When the middle would be
 * squeezed below HINT_COMPACT_BELOW columns the "palette" word is dropped
 * from the ^P hint to hand those columns to the workspace segment.
 *
 * Pure presentational. Theme tokens only. No inline hex.
 */

import { Box, Text } from "ink";
import React from "react";
import {
	cellWidth,
	fitHeaderMiddle,
	type HeaderMiddle,
} from "../lib/header-layout.js";
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

/** Width assumed when the caller does not report the terminal width. */
const DEFAULT_WIDTH = 80;
/** Below this many middle columns the ^P hint drops its "palette" label. */
const HINT_COMPACT_BELOW = 20;
/** Horizontal padding either side of the middle segment. */
const MIDDLE_PADDING = 2;
/** Round border (2) plus paddingX={1} (2) around pill and badge content. */
const BORDER_AND_PADDING = 4;

const PALETTE_HINT_FULL = " palette";
const MIC_ON = "● MIC";
const MIC_OFF = "○ MIC";
const ASK_CHIP = "[ASK]";
const LOCAL_CHIP = "LOCAL";
const BRAND_TAGLINE = " The Infinite Gentleman";

interface HeaderBarProps {
	updateAvailable?: { latest: string; current: string } | null;
	/** Current package version (e.g. "0.17.3"). Rendered in the brand pill so you always know what build you are on. */
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
	/** Terminal columns the header may use. Defaults to 80 when omitted. */
	width?: number;
}

/** Columns the brand pill occupies, borders and padding included. */
export function brandPillWidth(
	version: string | undefined,
	updateAvailable: HeaderBarProps["updateAvailable"],
): number {
	const text =
		"8gent Code." +
		(version ? ` v${version}` : "") +
		" │" +
		BRAND_TAGLINE +
		(updateAvailable ? `  │ ↑ v${updateAvailable.latest}` : "");
	return cellWidth(text) + BORDER_AND_PADDING;
}

/** Columns the right-hand status cluster occupies, badge included. */
export function statusClusterWidth(
	props: Pick<HeaderBarProps, "micOn" | "approvalPending" | "sessionTime" | "lilEightState">,
	compactHint: boolean,
): number {
	const hint = "^P" + (compactHint ? "" : PALETTE_HINT_FULL);
	const mic = props.micOn ? MIC_ON : MIC_OFF;
	const ask = props.approvalPending ? `${ASK_CHIP} ` : "";
	const text = `${hint}  ${mic}  ${ask}${LOCAL_CHIP} ${props.sessionTime} `;
	const badge = cellWidth(`8▣ ${props.lilEightState}`) + BORDER_AND_PADDING;
	return cellWidth(text) + badge;
}

/**
 * Decide the hint form and the fitted middle segment for a given width.
 * Exported so tests can pin the layout without rendering.
 */
export function planHeader(props: HeaderBarProps): {
	compactHint: boolean;
	middle: HeaderMiddle;
	middleAvailable: number;
} {
	const width = props.width ?? DEFAULT_WIDTH;
	const pill = brandPillWidth(props.version, props.updateAvailable);
	const fullRight = statusClusterWidth(props, false);
	let available = width - pill - fullRight - MIDDLE_PADDING;
	let compactHint = false;
	if (available < HINT_COMPACT_BELOW) {
		compactHint = true;
		available = width - pill - statusClusterWidth(props, true) - MIDDLE_PADDING;
	}
	const middleAvailable = Math.max(0, available);
	return {
		compactHint,
		middleAvailable,
		middle: fitHeaderMiddle(props.workspacePath, props.branch, props.syncStatus, middleAvailable),
	};
}

export function HeaderBar(props: HeaderBarProps) {
	const {
		updateAvailable,
		version,
		micOn,
		approvalPending,
		localFirst,
		sessionTime,
		lilEightState,
	} = props;
	const { compactHint, middle } = planHeader(props);

	return (
		<Box width="100%" justifyContent="space-between" alignItems="center" flexShrink={0} overflow="hidden">
			<Box flexShrink={0}>
				<BrandPill updateAvailable={updateAvailable} version={version} />
			</Box>

			<Box
				flexGrow={1}
				flexShrink={1}
				minWidth={0}
				paddingX={1}
				justifyContent="center"
				overflow="hidden"
			>
				{middle.branch ? (
					<Text wrap="truncate-end">
						{middle.path ? (
							<>
								<Text color={ui.muted}>{middle.path}</Text>
								<Text color={ui.teal}> ⎇ </Text>
							</>
						) : (
							<Text color={ui.teal}>⎇ </Text>
						)}
						<Text color={ui.orange}>{middle.branch}</Text>
						{middle.sync ? <Text color={ui.muted}> {middle.sync}</Text> : null}
					</Text>
				) : null}
			</Box>

			<Box flexShrink={0} justifyContent="flex-end">
				<Text color={ui.dim}>^P</Text>
				<Text color={ui.muted}>{compactHint ? "" : PALETTE_HINT_FULL}</Text>
				<Text color={ui.dim}>  </Text>
				<Text color={micOn ? t.red : ui.dim}>{micOn ? MIC_ON : MIC_OFF}</Text>
				<Text color={ui.dim}>  </Text>
				{approvalPending ? (
					<>
						<Text color={t.orange} bold>{ASK_CHIP}</Text>
						<Text color={ui.dim}> </Text>
					</>
				) : null}
				<Text color={localFirst ? t.green : ui.dim}>{LOCAL_CHIP}</Text>
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
