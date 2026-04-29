/**
 * ModeFooter — agent-mode chip row + keyboard hint row.
 *
 * Chips are flex-shared across the row; active chip uses brand cyan.
 * Padding kept minimal so the row stays one content line tall (border
 * still adds 1 row top + 1 row bottom). The hint row is its own block
 * underneath, three groups justified across the width.
 */

import { Box, Text } from "ink";
import React from "react";
import { theme } from "../theme.js";

const ui = {
	muted: theme.color.muted,
	dim: theme.color.dim,
	teal: theme.color.teal,
	chipBorder: theme.color.cardBorder,
} as const;

export const MODES = ["Planning", "Researching", "Implementing", "Testing", "Debugging"] as const;
export type FooterMode = (typeof MODES)[number];

export function ModeFooter({ active }: { active: FooterMode }) {
	return (
		<Box width="100%" flexDirection="column" flexShrink={0}>
			<Box gap={1} overflow="hidden">
				{MODES.map((mode) => {
					const isActive = mode === active;
					return (
						<Box
							key={mode}
							flexGrow={1}
							flexBasis={0}
							flexShrink={1}
							minWidth={0}
							borderStyle="round"
							borderColor={isActive ? ui.teal : ui.chipBorder}
							overflow="hidden"
						>
							<Text color={isActive ? ui.teal : ui.muted} bold={isActive} wrap="truncate-end">
								{" "}
								{isActive ? "◆" : "○"} {mode.toUpperCase()}{" "}
							</Text>
						</Box>
					);
				})}
				<Box flexShrink={0} alignItems="center" paddingX={1}>
					<Text color={ui.dim}>^Y MODE</Text>
				</Box>
			</Box>
			<Box justifyContent="space-between" overflow="hidden">
				<Text color={ui.muted}>^O expand  ^B processes  ^K kanban  ^P predict</Text>
				<Text color={ui.muted}>^G bg this  ^J jobs</Text>
				<Text color={ui.muted}>^A anim  ^S sound  ^C clear</Text>
			</Box>
		</Box>
	);
}
