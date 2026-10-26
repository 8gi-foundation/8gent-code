import { Box, Text, useStdout } from "ink";
import React from "react";
import { compactCardBox, fullCardBox, useCardView } from "../hooks/useApprovalCard.js";
import { cellWidth } from "../lib/header-layout.js";
import { t } from "../theme.js";
import { type CapSpec, KEY_CAP_GAP, KeyCapRow, keyCapText } from "./KeyCap.js";

/** The card's keys, as key caps (#3238): one format for every key in the HUD. */
export const APPROVAL_KEYS: ReadonlyArray<readonly [string, string]> = [
	["Y", "approve"],
	["N", "deny"],
	["E", "edit"],
	["S", "skip"],
];

/** The yolo question takes Y and N only. */
export const YOLO_GATE_KEYS: ReadonlyArray<readonly [string, string]> = [
	["Y", "yes"],
	["N", "no"],
];

/** The short verbs a narrow card falls back to; the keys stay the same. */
const NARROW_VERBS: Record<string, string> = { Y: "yes", N: "no" };

/** Cells a full card spends beside its keys: border and padding. */
const CARD_CHROME = 4;

/**
 * The key row for a card `width` cells wide, always on ONE row (a wrapped row
 * splits "[S]" from "skip" and breaks the click spans): full verbs with the
 * usual gap, then a one cell gap, then yes / no. Pure.
 */
export function approvalCaps(width: number, gate = false): CapSpec[] {
	const keys = gate ? YOLO_GATE_KEYS : APPROVAL_KEYS;
	const build = (narrow: boolean, gap: number): CapSpec[] =>
		keys.map(([cap, verb], i) => ({
			cap,
			verb: narrow ? (NARROW_VERBS[cap] ?? verb) : verb,
			gap: i > 0 ? gap : 0,
		}));
	const span = (caps: CapSpec[]) =>
		caps.reduce((n, c) => n + (c.gap ?? 0) + cellWidth(keyCapText(c.cap, c.verb)), 0);
	const tiers = [
		build(false, KEY_CAP_GAP.length),
		build(false, 1),
		build(true, KEY_CAP_GAP.length),
		build(true, 1),
	];
	return tiers.find((c) => span(c) <= width) ?? tiers[tiers.length - 1];
}

/** The full card's key row, sized to the screen it is drawn on. */
function FullKeys({ gate }: { gate?: boolean }) {
	const { stdout } = useStdout();
	return (
		<KeyCapRow
			caps={approvalCaps((stdout?.columns ?? 80) - CARD_CHROME, gate)}
			idPrefix="card"
			z={10}
		/>
	);
}

interface InlineApprovalPromptProps {
	/** The one-time yolo question: Y yes, N no. */
	gate?: boolean;
	/** Plain-language description of the action awaiting approval. */
	target: string;
	/** Why this card came up, e.g. "risky step" in Guarded (#3174). */
	reason?: string;
	/** Whole target, wrapped, keys below; never cut (MCP cards, #3474). */
	full?: boolean;
}

/** The target of a full card: wrapped by us to the card's width, every character kept, scrolling when taller than the screen. */
function FullTarget({ target }: { target: string }) {
	const view = useCardView(target);
	// A request's own full card (MCP) keeps the plain wrapped text and its whole-or-refused fit check.
	if (!view.auto)
		return (
			<Text color={t.textSecondary} wrap="wrap">
				{target}
			</Text>
		);
	return (
		<>
			{/* Cut to the card's width by us, every character kept: the person reads the whole command. */}
			<Box flexDirection="column">
				{view.shown.map((line, i) => (
					<Text key={`${view.offset + i}`} color={t.textSecondary} wrap="truncate">
						{line === "" ? " " : line}
					</Text>
				))}
			</Box>
			{view.paged ? (
				<Text color={t.muted}>
					{`${view.offset + 1}-${view.offset + view.shown.length} of ${view.lines.length}  [↑↓] scroll${view.atEnd ? "  end shown" : "  [Y] after the end"}`}
				</Text>
			) : null}
		</>
	);
}

/**
 * InlineApprovalPrompt
 *
 * Bordered inline card asking the user to approve a tool call.
 * Presentational only. Wiring into NemoClaw's approve callback is a
 * separate follow-up issue.
 *
 * Keys offered: [Y] approve  [N] deny  [E] edit  [S] skip.
 */
export function InlineApprovalPrompt({ target, reason, full, gate }: InlineApprovalPromptProps) {
	if (full) {
		return (
			<Box
				ref={fullCardBox}
				borderStyle="round"
				borderColor={t.orange}
				paddingX={1}
				marginTop={1}
				flexShrink={0}
				flexDirection="column"
			>
				<Box>
					<Text color={t.orange} bold>
						ASK
					</Text>
					{reason ? (
						<Box marginLeft={1}>
							<Text color={t.muted}>{reason}</Text>
						</Box>
					) : null}
				</Box>
				<FullTarget target={target} />
				<Box justifyContent="flex-end">
					<FullKeys gate={gate} />
				</Box>
			</Box>
		);
	}
	return (
		<Box
			ref={compactCardBox}
			borderStyle="round"
			borderColor={t.orange}
			paddingX={1}
			marginTop={1}
			flexShrink={0}
			justifyContent="space-between"
		>
			<Box minWidth={0}>
				{/* Margin, not a trailing space: Ink trims trailing whitespace when
				    the truncated target squeezes the row, which rendered "ASKcd". */}
				<Box flexShrink={0} marginRight={1}>
					<Text color={t.orange} bold>
						ASK
					</Text>
				</Box>
				{reason ? (
					<Box flexShrink={0} marginRight={1}>
						<Text color={t.muted}>{reason}</Text>
					</Box>
				) : null}
				<Text color={t.textSecondary} wrap="truncate-end">
					{target}
				</Text>
			</Box>
			{/* sharedGap 0: the cells between caps hit nothing. A gap click must
			    never approve; a miss here does nothing and the user aims again. */}
			<KeyCapRow
				caps={(gate ? YOLO_GATE_KEYS : APPROVAL_KEYS).map(([cap, verb]) => ({ cap, verb }))}
				idPrefix="card"
				z={10}
				sharedGap={0}
			/>
		</Box>
	);
}

export type { InlineApprovalPromptProps };
