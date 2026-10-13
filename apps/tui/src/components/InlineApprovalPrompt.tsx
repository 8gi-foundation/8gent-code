import { Box, Text } from "ink";
import React from "react";
import { fullCardBox } from "../hooks/useApprovalCard.js";
import { t } from "../theme.js";
import { KeyCapRow } from "./KeyCap.js";

/** The card's keys, as key caps (#3238): one format for every key in the HUD. */
export const APPROVAL_KEYS: ReadonlyArray<readonly [string, string]> = [
	["Y", "approve"],
	["N", "deny"],
	["E", "edit"],
	["S", "skip"],
];

interface InlineApprovalPromptProps {
	/** Plain-language description of the action awaiting approval. */
	target: string;
	/** Why this card came up, e.g. "risky step" in Guarded (#3174). */
	reason?: string;
	/** Whole target, wrapped, keys below; never cut (MCP cards, #3474). */
	full?: boolean;
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
export function InlineApprovalPrompt({ target, reason, full }: InlineApprovalPromptProps) {
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
				<Text color={t.textSecondary} wrap="wrap">
					{target}
				</Text>
				<Box justifyContent="flex-end">
					<KeyCapRow
						caps={APPROVAL_KEYS.map(([cap, verb]) => ({ cap, verb }))}
						idPrefix="card"
						z={10}
					/>
				</Box>
			</Box>
		);
	}
	return (
		<Box
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
				caps={APPROVAL_KEYS.map(([cap, verb]) => ({ cap, verb }))}
				idPrefix="card"
				z={10}
				sharedGap={0}
			/>
		</Box>
	);
}

export type { InlineApprovalPromptProps };
