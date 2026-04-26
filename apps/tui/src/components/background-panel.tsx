import { Box, useInput } from "ink";
/**
 * BackgroundPanel: a small, non-modal side panel listing tasks the user
 * sent to the background via Ctrl+G. Toggled with Ctrl+J ("jobs").
 *
 * UX contract:
 * - Status glyph + text label (never colour-only) for screen readers.
 * - No animation on row changes. Respects reduced-motion house rule.
 * - Rows are read-only; closing is Ctrl+J again or Escape.
 * - Keyboard-only friendly: Escape returns focus to foreground input.
 */
import React from "react";
import type { BgTask } from "../lib/background-pool.js";
import { AppText, Divider, Heading, MutedText, StatusDot } from "./primitives/index.js";

interface BackgroundPanelProps {
	tasks: BgTask[];
	onClose: () => void;
	width?: number;
}

function statusLabel(t: BgTask): {
	dot: "success" | "error" | "info";
	text: string;
} {
	if (t.status === "running") return { dot: "info", text: "running" };
	if (t.status === "done") return { dot: "success", text: "complete" };
	return { dot: "error", text: "error" };
}

function formatElapsed(t: BgTask): string {
	const end = t.finishedAt ?? Date.now();
	const secs = Math.max(0, Math.round((end - t.startedAt) / 1000));
	if (secs < 60) return `${secs}s`;
	const mins = Math.floor(secs / 60);
	const rem = secs % 60;
	return rem === 0 ? `${mins}m` : `${mins}m ${rem}s`;
}

export function BackgroundPanel({ tasks, onClose, width = 44 }: BackgroundPanelProps) {
	useInput((_input, key) => {
		if (key.escape) onClose();
	});

	return (
		<Box
			flexDirection="column"
			borderStyle="single"
			borderColor="cyan"
			paddingX={1}
			width={width}
			flexShrink={0}
		>
			<Heading>Background jobs</Heading>
			<MutedText>Ctrl+J to close. Escape to dismiss.</MutedText>
			<Divider />
			{tasks.length === 0 ? (
				<MutedText>No background tasks yet. Press Ctrl+G while a task is running.</MutedText>
			) : (
				tasks.map((t) => {
					const s = statusLabel(t);
					return (
						<Box key={t.id} flexDirection="column" marginBottom={1}>
							<Box flexDirection="row">
								<StatusDot status={s.dot} />
								<AppText> {s.text} </AppText>
								<MutedText>({formatElapsed(t)})</MutedText>
							</Box>
							<AppText wrap="truncate-end">{t.label}</AppText>
							{t.status === "done" && t.resultPreview && (
								<MutedText wrap="truncate-end">{t.resultPreview}</MutedText>
							)}
							{t.status === "error" && t.error && (
								<MutedText wrap="truncate-end">error: {t.error}</MutedText>
							)}
						</Box>
					);
				})
			)}
		</Box>
	);
}
