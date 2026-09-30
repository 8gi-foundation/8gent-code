import { Box, Text } from "ink";
import React from "react";
import { t } from "../theme.js";
import { KEY_CAP_GAP, KeyCap } from "./KeyCap.js";

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
export function InlineApprovalPrompt({ target, reason }: InlineApprovalPromptProps) {
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
			<Box flexShrink={0}>
				<Text>
					{APPROVAL_KEYS.map(([cap, verb], i) => (
						<Text key={cap}>
							{i > 0 ? KEY_CAP_GAP : ""}
							<KeyCap cap={cap} verb={verb} />
						</Text>
					))}
				</Text>
			</Box>
		</Box>
	);
}

export type { InlineApprovalPromptProps };
