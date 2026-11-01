import { Box } from "ink";
import type React from "react";
import { useViewport } from "../../hooks/useViewport.js";

interface FixedFrameProps {
	children: React.ReactNode;
}

/**
 * The HUD is one row shorter than the terminal (#3227). When a frame fills
 * the terminal height, Ink takes its fullscreen branch and writes
 * clearTerminal before every commit: that erases the screen and the
 * scrollback, 25 times a minute on an idle HUD. One row short, Ink updates
 * the frame in place instead.
 */
export function frameHeight(rows: number): number {
	return Math.max(1, rows - 1);
}

export function FixedFrame({ children }: FixedFrameProps) {
	const viewport = useViewport();

	return (
		<Box
			height={frameHeight(viewport.height)}
			width="100%"
			flexDirection="column"
			overflow="hidden"
		>
			{children}
		</Box>
	);
}
