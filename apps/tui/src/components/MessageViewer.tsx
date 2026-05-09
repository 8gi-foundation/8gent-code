/**
 * MessageViewer — full-screen, scrollable single-message reader.
 *
 * Activated when the user selects a bubble and presses Enter.
 * Up/Down arrows: navigate between messages (or scroll within a long one).
 * PgUp/PgDn: page-scroll within the current message.
 * Escape: close and return to the bubble strip.
 */

import { Box, Text, useInput } from "ink";
import React, { useState } from "react";

interface ViewerMessage {
	id: string;
	role: "user" | "assistant" | "system" | "tool";
	content: string;
	timestamp: Date;
}

interface MessageViewerProps {
	messages: ViewerMessage[];
	initialIndex: number;
	onClose: () => void;
	contentWidth: number;
	height: number;
}

const ROLE_LABEL: Record<string, string> = {
	user: "You",
	assistant: "8gent",
	system: "System",
	tool: "Tool",
};

const ROLE_COLOR: Record<string, string> = {
	user: "yellow",
	assistant: "cyan",
	system: "gray",
	tool: "magenta",
};

export function MessageViewer({
	messages,
	initialIndex,
	onClose,
	contentWidth,
	height,
}: MessageViewerProps) {
	const viewable = messages.filter((m) => m.role !== "tool");
	const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
	const [idx, setIdx] = useState(clamp(initialIndex, 0, Math.max(0, viewable.length - 1)));
	const [scrollLine, setScrollLine] = useState(0);

	// header(1) + sep(1) + footer(1) + sep(1) = 4 chrome rows
	const bodyHeight = Math.max(3, height - 4);
	const msg = viewable[idx];
	const lines = msg?.content.split("\n") ?? [];
	const maxScroll = Math.max(0, lines.length - bodyHeight);

	useInput((_input, key) => {
		if (key.escape) {
			onClose();
			return;
		}
		if (key.upArrow) {
			if (scrollLine > 0) {
				setScrollLine((p) => p - 1);
			} else if (idx > 0) {
				setIdx((p) => p - 1);
				setScrollLine(0);
			}
			return;
		}
		if (key.downArrow) {
			if (scrollLine < maxScroll) {
				setScrollLine((p) => p + 1);
			} else if (idx < viewable.length - 1) {
				setIdx((p) => p + 1);
				setScrollLine(0);
			}
			return;
		}
		if (key.pageUp) {
			setScrollLine((p) => Math.max(0, p - bodyHeight));
			return;
		}
		if (key.pageDown) {
			setScrollLine((p) => Math.min(maxScroll, p + bodyHeight));
			return;
		}
	});

	const sep = "─".repeat(Math.max(4, contentWidth - 2));

	if (!msg) {
		return (
			<Box flexDirection="column" paddingX={1}>
				<Text dimColor>No message to display.</Text>
				<Text dimColor>Esc to go back</Text>
			</Box>
		);
	}

	const roleLabel = ROLE_LABEL[msg.role] ?? msg.role;
	const roleColor = ROLE_COLOR[msg.role] ?? "white";
	const timeStr = msg.timestamp.toLocaleTimeString("en-US", {
		hour: "2-digit",
		minute: "2-digit",
	});
	const visibleLines = lines.slice(scrollLine, scrollLine + bodyHeight);
	const scrollInfo =
		maxScroll > 0 ? `  ${scrollLine + 1}–${Math.min(scrollLine + bodyHeight, lines.length)}/${lines.length}` : "";

	return (
		<Box flexDirection="column" height={height}>
			{/* Header row */}
			<Box paddingX={1}>
				<Text dimColor>{"msg "}</Text>
				<Text color="cyan" bold>
					{idx + 1}
				</Text>
				<Text dimColor>{"/" + viewable.length + "  "}</Text>
				<Text color={roleColor} bold>
					{roleLabel}
				</Text>
				<Text dimColor>{"  " + timeStr + scrollInfo}</Text>
			</Box>

			{/* Top separator */}
			<Box paddingX={1}>
				<Text dimColor>{sep}</Text>
			</Box>

			{/* Message body */}
			<Box flexDirection="column" flexGrow={1} paddingX={2} overflow="hidden">
				{visibleLines.map((line, i) => (
					<Text key={scrollLine + i} wrap="wrap">
						{line || " "}
					</Text>
				))}
			</Box>

			{/* Bottom separator + nav hint */}
			<Box paddingX={1}>
				<Text dimColor>{sep}</Text>
			</Box>
			<Box paddingX={1} justifyContent="center">
				<Text dimColor>↑↓ scroll/nav · PgUp/Dn page · Esc close</Text>
			</Box>
		</Box>
	);
}
