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
 * from the ^P hint to hand those columns to the workspace segment. Tighter
 * still, the pill drops its tagline, then the middle goes entirely, so the
 * status badge on the right edge is never the part that gets clipped.
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
	// Brand mark and the update notice only.
	orange:     t.orange,
	teal:       t.teal,
	// The brand pill is chrome, not state: orange stays for the active tab,
	// DONE, the input and the selection.
	pillBorder: t.border,
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

/**
 * Columns the brand pill occupies, borders and padding included. The
 * compact pill drops the tagline: on a narrow terminal the status badge and
 * the branch carry more than the brand line does.
 */
export function brandPillWidth(
	version: string | undefined,
	updateAvailable: HeaderBarProps["updateAvailable"],
	compact = false,
): number {
	const text =
		"8gent Code" +
		(version ? ` v${version}` : "") +
		(compact ? "" : " │" + BRAND_TAGLINE) +
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

/** Fewest middle columns worth rendering: the branch glyph and a 4-cell slice. */
const MIDDLE_MIN = 6;

/**
 * Decide the pill form, the hint form and the fitted middle segment for a
 * given width. The status badge is never the thing that gets cut: when the
 * row is tight the header gives up, in order, the "palette" word, the
 * tagline, and finally the whole workspace segment with its padding.
 * Exported so tests can pin the layout without rendering.
 */
export function planHeader(props: HeaderBarProps): {
	compactHint: boolean;
	compactBrand: boolean;
	middle: HeaderMiddle;
	middleAvailable: number;
} {
	const width = props.width ?? DEFAULT_WIDTH;
	const steps: Array<[compactBrand: boolean, compactHint: boolean]> = [
		[false, false],
		[false, true],
		[true, false],
		[true, true],
	];
	for (const [compactBrand, compactHint] of steps) {
		const available =
			width -
			brandPillWidth(props.version, props.updateAvailable, compactBrand) -
			statusClusterWidth(props, compactHint) -
			MIDDLE_PADDING;
		// The first two steps keep the old rule: the full hint needs a roomy
		// middle, so a merely-fitting branch still trades the word away.
		const floor = !compactHint && !compactBrand ? HINT_COMPACT_BELOW : MIDDLE_MIN;
		if (available >= floor) {
			const middle = fitHeaderMiddle(props.workspacePath, props.branch, props.syncStatus, available);
			if (middle.branch || middle.path || middle.sync) {
				return { compactHint, compactBrand, middle, middleAvailable: available };
			}
		}
	}
	// No room for a branch at all: compact pill, compact hint, no middle.
	return {
		compactHint: true,
		compactBrand: true,
		middleAvailable: 0,
		middle: { path: "", branch: "", sync: "" },
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
	const { compactHint, compactBrand, middle } = planHeader(props);

	return (
		<Box width="100%" justifyContent="space-between" alignItems="center" flexShrink={0} overflow="hidden">
			<Box flexShrink={0}>
				<BrandPill updateAvailable={updateAvailable} version={version} compact={compactBrand} />
			</Box>

			{middle.branch || middle.path || middle.sync ? (
				// Reads from the left, one column clear of the pill, at every
				// width: "no repo" and "⎇ branch" sit where the path starts,
				// never floating in the middle of the leftover space.
				<Box
					flexGrow={1}
					flexShrink={1}
					minWidth={0}
					paddingX={1}
					justifyContent="flex-start"
					overflow="hidden"
				>
					<Text wrap="truncate-end">
						{middle.path ? <Text color={ui.muted}>{middle.path}</Text> : null}
						{middle.branch ? (
							<>
								<Text color={ui.teal}>{middle.path ? " ⎇ " : "⎇ "}</Text>
								<Text color={ui.cream}>{middle.branch}</Text>
							</>
						) : null}
						{middle.sync ? (
							<Text color={ui.muted}>
								{middle.path || middle.branch ? " " : ""}
								{middle.sync}
							</Text>
						) : null}
					</Text>
				</Box>
			) : (
				// Nothing fits in the middle: an unpadded spacer, so the row
				// never spends columns the status badge needs.
				<Box flexGrow={1} flexShrink={1} minWidth={0} />
			)}

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
	compact = false,
}: {
	updateAvailable?: { latest: string; current: string } | null;
	version?: string;
	compact?: boolean;
}) {
	return (
		<Box borderStyle="round" borderColor={ui.pillBorder} paddingX={1} flexShrink={0}>
			<BrandWord />
			<Text color={ui.muted}> Code</Text>
			{version ? (
				<>
					<Text color={ui.dim}> </Text>
					<Text color={ui.muted}>v{version}</Text>
				</>
			) : null}
			{compact ? null : (
				<>
					<Text color={ui.dim}> </Text>
					<Text color={ui.dim}>│</Text>
					<Text color={ui.muted}> The Infinite </Text>
					<Text color={ui.teal}>Gentleman</Text>
				</>
			)}
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
