import { Box } from "ink";
import React from "react";
import { Narrator } from "../components/narrator/Narrator.js";
import { AppText, MutedText } from "../components/primitives/AppText.js";
import { Divider } from "../components/primitives/Divider.js";
import { Spacer } from "../components/primitives/Spacer.js";
import { Stack } from "../components/primitives/Stack.js";
import { TaskCardList, type TaskItem } from "../components/task-card/TaskCardList.js";

export interface NarratorViewProps {
	tasks: TaskItem[];
	narratorText: string;
	maxHeight: number;
}

const NARRATOR_AREA_LINES = 4;

export function NarratorView({ tasks, narratorText, maxHeight }: NarratorViewProps) {
	if (!tasks || tasks.length === 0) {
		return (
			<Box flexDirection="column" alignItems="center" justifyContent="center" height={maxHeight}>
				<Box>
					<AppText color="cyan">✦</AppText>
					<MutedText> Awaiting your command…</MutedText>
				</Box>
			</Box>
		);
	}

	const taskListHeight = Math.max(1, maxHeight - NARRATOR_AREA_LINES);

	return (
		<Box flexDirection="column" height={maxHeight}>
			<Box flexDirection="column" height={taskListHeight} flexShrink={0}>
				<TaskCardList tasks={tasks} maxHeight={taskListHeight} focusable={true} />
			</Box>
			<Divider />
			<Box flexDirection="column" flexGrow={0}>
				<Narrator text={narratorText} />
			</Box>
		</Box>
	);
}
