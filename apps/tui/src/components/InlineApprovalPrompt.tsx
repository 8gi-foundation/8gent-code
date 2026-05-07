import { Box, Text } from "ink";
import React from "react";
import { t } from "../theme.js";

interface InlineApprovalPromptProps {
	/** Plain-language description of the action awaiting approval. */
	target: string;
}

/**
 * InlineApprovalPrompt
 *
 * Bordered inline card asking the user to approve a tool call.
 * Presentational only. Wiring into NemoClaw's approve callback is a
 * separate follow-up issue.
 *
 * Keys offered: Y approve / N deny / E edit / S skip.
 */
export function InlineApprovalPrompt({ target }: InlineApprovalPromptProps) {
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
				<Text color={t.orange} bold>
					ASK{" "}
				</Text>
				<Text color={t.textSecondary} wrap="truncate-end">
					{target}
				</Text>
			</Box>
			<Box flexShrink={0}>
				<Text color={t.green}>Y approve</Text>
				<Text color={t.dim}> / </Text>
				<Text color={t.red}>N deny</Text>
				<Text color={t.dim}> / </Text>
				<Text color={t.orange}>E edit</Text>
				<Text color={t.dim}> / </Text>
				<Text color={t.muted}>S skip</Text>
			</Box>
		</Box>
	);
}

export type { InlineApprovalPromptProps };
