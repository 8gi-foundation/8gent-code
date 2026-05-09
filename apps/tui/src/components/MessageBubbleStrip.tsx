/**
 * MessageBubbleStrip — compact single-line message list.
 *
 * Each message renders as one row: role label + truncated preview + timestamp.
 * When isFocused, a ▶ cursor selects the active row and Up/Down keys navigate.
 * Press Enter on a selected bubble to open the full MessageViewer.
 */

import { Box, Text } from "ink";
import React from "react";
import { t } from "../theme.js";

interface BubbleMessage {
	id: string;
	role: "user" | "assistant" | "system" | "tool";
	content: string;
	timestamp: Date;
}

interface MessageBubbleStripProps {
	messages: BubbleMessage[];
	isFocused: boolean;
	selectedIndex: number;
	contentWidth: number;
	maxVisible: number;
}

const ROLE_LABEL: Record<string, string> = {
	user: "  you",
	assistant: " 8gnt",
	system: "  sys",
	tool: " tool",
};

const ROLE_COLOR: Record<string, string> = {
	user:      t.textPrimary,
	assistant: t.orange,
	system:    t.textTertiary,
	tool:      t.orange,
};

function relativeTime(date: Date): string {
	const diff = Date.now() - date.getTime();
	const s = Math.floor(diff / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h`;
	return date.toLocaleDateString();
}

export function MessageBubbleStrip({
	messages,
	isFocused,
	selectedIndex,
	contentWidth,
	maxVisible,
}: MessageBubbleStripProps) {
	const visible = messages.filter((m) => m.role !== "tool");

	if (visible.length === 0) {
		return (
			<Box flexGrow={1} alignItems="center" justifyContent="center">
				<Text dimColor>─── No messages yet. Start typing below. ───</Text>
			</Box>
		);
	}

	// Keep the selected bubble in the visible window
	const halfWindow = Math.floor(maxVisible / 2);
	const rawStart = Math.max(0, selectedIndex - halfWindow);
	const start = Math.min(rawStart, Math.max(0, visible.length - maxVisible));
	const toShow = visible.slice(start, start + maxVisible);

	// Reserve space: cursor(2) + label(5) + space(2) + preview + space(2) + timestamp(4)
	const previewWidth = Math.max(10, contentWidth - 17);

	return (
		<Box flexDirection="column" flexGrow={1} minHeight={0}>
			{toShow.map((msg, i) => {
				const actualIndex = start + i;
				const isSelected = isFocused && actualIndex === selectedIndex;
				const raw = msg.content.replace(/\s+/g, " ").trim();
				const preview =
					raw.length > previewWidth ? `${raw.slice(0, previewWidth - 1)}…` : raw;
				const label = ROLE_LABEL[msg.role] ?? "  ???";
				const color = ROLE_COLOR[msg.role] ?? "white";
				const ago = relativeTime(msg.timestamp);

				// Preview text: white for user/assistant, dim for system/tool
				const isConversation = msg.role === "user" || msg.role === "assistant";
				const previewColor = isSelected ? "white" : isConversation ? "white" : "gray";
				const previewDim = !isConversation && !isSelected;

				return (
					<Box key={msg.id}>
						<Text color={isSelected ? "cyan" : "gray"}>{isSelected ? "▶ " : "  "}</Text>
						<Text color={color} bold={isSelected || isConversation} dimColor={!isConversation && !isSelected}>
							{label}
						</Text>
						<Text color={previewColor} dimColor={previewDim}>
							{"  "}
							{preview}
						</Text>
						<Text dimColor>{"  " + ago}</Text>
					</Box>
				);
			})}

			{isFocused && (
				<Box paddingTop={1}>
					<Text dimColor>↑↓ navigate · Enter read · Ctrl+L exit · Esc exit</Text>
				</Box>
			)}
		</Box>
	);
}
