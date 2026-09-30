/**
 * HeaderBar - top-of-frame brand row (HUD system, #3238).
 *
 * The living braille 8 and the brand pill on the left; workspace path,
 * branch and sync in the middle; on the right only the state chips that
 * ask for the person, and only while they apply: ASK (an approval card is
 * up), INFINITE (the tab runs without asking), ● MIC (recording). A quiet
 * header is the default. The clock is in the footer, the palette key is the
 * footer's first key cap, and the Lil Eight badge is gone: the living 8 is
 * the pet, and the NOW strip says what the agent is doing.
 *
 * Every piece of text sits on the pill's text row, the middle of the three
 * rows. The row never wraps: the pill and the chips never shrink; the
 * middle is fitted by `fitHeaderMiddle`, branch before the tail of the
 * path. Tighter still, the pill drops its tagline, then the middle goes.
 *
 * Pure presentational. Theme tokens only. No inline hex.
 */

import { Box, Text, useStdout } from "ink";
import React, { useEffect } from "react";
import {
	cellWidth,
	fitHeaderMiddle,
	type HeaderMiddle,
} from "../lib/header-layout.js";
import { INTRO_PALETTE } from "../lib/intro-converge.js";
import {
	MARK_COLUMNS,
	MIN_COLS,
	type MarkStream,
	headerMarkFrame,
	livingMarkWriter,
} from "../lib/living-mark.js";
import { drawsColour, glyphs } from "../lib/term-caps.js";
import { t } from "../theme.js";

const ui = {
	cream:      t.textPrimary,
	muted:      t.textTertiary,
	dim:        t.textDim,
	// Brand mark and the update notice only.
	orange:     t.orange,
	teal:       t.teal,
	// The brand pill is a Surface (#3238): the frame token, like every edge.
	pillBorder: t.frame,
} as const;

/** Width assumed when the caller does not report the terminal width. */
const DEFAULT_WIDTH = 80;
/** Horizontal padding either side of the middle segment. */
const MIDDLE_PADDING = 2;
/** Round border (2) plus paddingX={1} (2) around the pill content. */
const BORDER_AND_PADDING = 4;
/** Columns between two chips, and between the last chip and the right edge. */
const CHIP_GAP = 2;

/** An approval card is up. The card itself says ASK too; the chip is its echo where the eye lands first. */
const ASK_CHIP = "ASK";
/** Running without asking is the one permission mode that earns a header chip (#3174). */
const INFINITE_CHIP = "INFINITE";
const MIC_CHIP = "● MIC";
const BRAND_TAGLINE = " The Infinite Gentleman";

interface HeaderBarProps {
	updateAvailable?: { latest: string; current: string } | null;
	/** Current package version (e.g. "0.17.3"). Rendered in the brand pill so you always know what build you are on. */
	version?: string;
	workspacePath: string;
	branch: string;
	/** "ahead 1", "behind 2", "in sync", etc. */
	syncStatus: string;
	/** Voice is recording. Off draws nothing (#3238). */
	micOn: boolean;
	approvalPending: boolean;
	/** Terminal columns the header may use. Defaults to 80 when omitted. */
	width?: number;
	/**
	 * The HUD wants the braille 8 alive: the main view is up, nothing sits
	 * over it, motion is on. The mark still holds still for the terminal's
	 * own reasons (lib/living-mark.ts). Off by default.
	 */
	living?: boolean;
	/** Draw the braille 8 beside the pill when it fits. Defaults to true where braille draws. */
	mark?: boolean;
	/**
	 * The focused tab's permission mode (#3174). Only Infinite changes the
	 * header: an INFINITE chip beside ASK. The living 8 never changes with it.
	 */
	permMode?: string;
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

/** The chips the header shows right now, in priority order (#3238). */
export function headerChips(
	props: Pick<HeaderBarProps, "micOn" | "approvalPending" | "permMode">,
): string[] {
	const chips: string[] = [];
	if (props.approvalPending) chips.push(ASK_CHIP);
	if (props.permMode === "infinite") chips.push(INFINITE_CHIP);
	if (props.micOn) chips.push(MIC_CHIP);
	return chips;
}

/** Columns the right-hand chips occupy, gaps and the right margin included. */
export function statusClusterWidth(
	props: Pick<HeaderBarProps, "micOn" | "approvalPending" | "permMode">,
): number {
	const chips = headerChips(props);
	if (chips.length === 0) return 0;
	// Each chip and the gap after it, plus one column clear of the middle.
	return 1 + chips.reduce((sum, c) => sum + cellWidth(c) + CHIP_GAP, 0);
}

/** Fewest middle columns worth rendering: the branch glyph and a 4-cell slice. */
const MIDDLE_MIN = 6;
/** The tagline stays only while the middle keeps at least this many columns. */
const TAGLINE_MIDDLE_MIN = 20;
/** Narrower than this, the pill is always compact. */
const TAGLINE_MIN_COLS = 100;

/**
 * Decide the pill form and the fitted middle segment for a given width. The
 * chips are never cut: when the row is tight the header gives up, in order,
 * the tagline and then the whole workspace segment with its padding.
 * Exported so tests can pin the layout without rendering.
 */
export interface HeaderPlan {
	compactBrand: boolean;
	middle: HeaderMiddle;
	middleAvailable: number;
	/** The braille 8 sits left of the pill, in the header's first MARK_COLUMNS columns. */
	mark: boolean;
}

/**
 * The braille 8 takes MARK_COLUMNS only when it costs nothing that carries
 * information: the same pill, the whole branch, and the sync state whenever
 * it would show without it. Only the tail of an already-shortened path may
 * give way. When columns run out it is the first thing to go. Never on a
 * terminal that cannot draw braille.
 */
export function planHeader(props: HeaderBarProps): HeaderPlan {
	const width = props.width ?? DEFAULT_WIDTH;
	const plain = planRow(props, width);
	const wantMark = (props.mark ?? glyphs().eight === null) && width >= MIN_COLS;
	if (wantMark) {
		const withMark = planRow(props, width - MARK_COLUMNS);
		const free =
			withMark.compactBrand === plain.compactBrand &&
			withMark.middle.branch === plain.middle.branch &&
			(plain.middle.sync === "" || withMark.middle.sync === plain.middle.sync) &&
			(withMark.middle.branch !== "" || withMark.middle.path !== "");
		if (free) return { ...withMark, mark: true };
	}
	return { ...plain, mark: false };
}

function planRow(props: HeaderBarProps, width: number): Omit<HeaderPlan, "mark"> {
	// Below TAGLINE_MIN_COLS the tagline always steps aside (#3238): at 80
	// columns the living 8 and the branch say more than the brand line, and
	// a chip appearing must never be what pushes the 8 out.
	for (const compactBrand of (props.width ?? DEFAULT_WIDTH) < TAGLINE_MIN_COLS ? [true] : [false, true]) {
		const available =
			width -
			brandPillWidth(props.version, props.updateAvailable, compactBrand) -
			statusClusterWidth(props) -
			MIDDLE_PADDING;
		// The tagline needs a roomy middle: a merely-fitting branch still trades it away.
		const floor = compactBrand ? MIDDLE_MIN : TAGLINE_MIDDLE_MIN;
		if (available >= floor) {
			const middle = fitHeaderMiddle(props.workspacePath, props.branch, props.syncStatus, available);
			if (middle.branch || middle.path || middle.sync) {
				return { compactBrand, middle, middleAvailable: available };
			}
		}
	}
	// No room for a branch at all: compact pill, no middle.
	return {
		compactBrand: true,
		middleAvailable: 0,
		middle: { path: "", branch: "", sync: "" },
	};
}

export function HeaderBar(props: HeaderBarProps) {
	const { updateAvailable, version } = props;
	const { compactBrand, middle, mark } = planHeader(props);
	const chips = headerChips(props);

	return (
		<Box width="100%" justifyContent="space-between" alignItems="center" flexShrink={0} overflow="hidden">
			<Box flexShrink={0}>
				{mark ? <HeaderMark living={Boolean(props.living)} /> : null}
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
				// never spends columns the chips need.
				<Box flexGrow={1} flexShrink={1} minWidth={0} />
			)}

			{chips.length > 0 ? (
				// One row, centred on the pill's text row by the header's
				// alignItems (the chips were on the pill's top edge before #3238).
				// The right margin mirrors the pill's border and padding on the left.
				<Box flexShrink={0} marginLeft={1} marginRight={CHIP_GAP}>
					<Text>
						{chips.map((chip, i) => (
							<Text key={chip}>
								{i > 0 ? "  " : ""}
								<Text color={chip === MIC_CHIP ? t.red : t.orange} bold>
									{chip}
								</Text>
							</Text>
						))}
					</Text>
				</Box>
			) : null}
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

const MARK_STILL = headerMarkFrame(0, false);

/**
 * The braille 8, three rows beside the three-row pill, drawn still by Ink.
 * While `living`, the writer in lib/living-mark.ts keeps its cells alive
 * without a single Ink render. Under NO_COLOR it is shape only.
 */
export function HeaderMark({ living }: { living: boolean }) {
	const { stdout } = useStdout();
	// Declared first so it runs first on unmount: the header is leaving, so
	// the writer stops without painting the still mark over whatever follows.
	useEffect(() => {
		if (!stdout) return;
		return () => livingMarkWriter(stdout as unknown as MarkStream).setActive(false, false);
	}, [stdout]);
	useEffect(() => {
		if (!living || !stdout) return;
		const writer = livingMarkWriter(stdout as unknown as MarkStream);
		writer.setActive(true);
		return () => writer.setActive(false);
	}, [living, stdout]);
	const colour = drawsColour();
	return (
		<Box flexDirection="column" flexShrink={0} marginRight={MARK_COLUMNS - MARK_STILL[0].length}>
			{MARK_STILL.map((row, r) => (
				<Text key={r}>
					{row.map((cell, k) => (
						<Text key={k} color={colour && cell.colour ? INTRO_PALETTE[cell.colour] : undefined}>
							{cell.ch}
						</Text>
					))}
				</Text>
			))}
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
