import { Box, Text } from "ink";
import React from "react";
import { t } from "../../theme.js";
import type { TaskInfo } from "../../../../../packages/tools/background.js";
import { formatBytes, formatDuration } from "../../lib/format.js";
import { truncate } from "../../lib/text.js";
import { AppText, MutedText } from "../primitives/AppText.js";
import { Inline } from "../primitives/Inline.js";
import { StatusDot } from "../primitives/StatusDot.js";

function statusToDot(status: string): "success" | "error" | "warning" | "info" | "idle" {
	switch (status) {
		case "running":
			return "info";
		case "completed":
			return "success";
		case "failed":
			return "error";
		case "killed":
			return "warning";
		default:
			return "idle";
	}
}

interface ProcessListItemProps {
	task: TaskInfo;
	selected: boolean;
	maxWidth: number;
}

export function ProcessListItem({ task, selected, maxWidth }: ProcessListItemProps) {
	const cmdWidth = Math.max(8, maxWidth - 16);
	const cmd = truncate(task.command, cmdWidth);
	const duration = formatDuration(task.runtime);
	const isDone = task.status === "completed" || task.status === "killed";
	const isFailed = task.status === "failed";

	return (
		<Box paddingX={1}>
			<Inline gap={1}>
				<StatusDot status={statusToDot(task.status)} />
				{selected ? (
					<Text inverse bold>{` ${cmd} `}</Text>
				) : isFailed ? (
					<Text color={t.red} dimColor>{cmd}</Text>
				) : isDone ? (
					<Text color={t.orange} dimColor>{cmd}</Text>
				) : (
					<AppText>{cmd}</AppText>
				)}
			</Inline>
			<Box flexGrow={1} />
			<MutedText>{duration}</MutedText>
		</Box>
	);
}
