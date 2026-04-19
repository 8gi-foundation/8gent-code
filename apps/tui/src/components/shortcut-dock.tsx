/**
 * ShortcutDock - iOS Dock adapted for Ink TUI.
 *
 * Semantic clusters separated by subtle dividers (panels | toggles | exit),
 * keycap glyphs use the macOS menu-bar Control symbol (⌃) for clarity,
 * labels defer to muted weight so the keys read as the primary affordance.
 */

import React from "react";
import { Box } from "ink";
import { AppText, MutedText } from "./primitives/index.js";
import { truncate } from "../lib/index.js";

interface Shortcut {
	key: string;
	label: string;
}

interface Cluster {
	items: Shortcut[];
}

const CLUSTERS: Cluster[] = [
	{
		items: [
			{ key: "O", label: "expand" },
			{ key: "B", label: "processes" },
			{ key: "K", label: "kanban" },
			{ key: "P", label: "predict" },
		],
	},
	{
		items: [
			{ key: "A", label: "anim" },
			{ key: "S", label: "sound" },
		],
	},
	{
		items: [{ key: "C", label: "exit" }],
	},
];

const CTRL = "\u2303"; // ⌃ macOS Control glyph
const DIVIDER = "\u00B7"; // · cluster separator

export function ShortcutDock({ viewportWidth }: { viewportWidth: number }) {
	// Plain-text fallback string we'd render if we had no color — used so the
	// existing truncate() can decide whether the dock fits before we build JSX.
	const plain = CLUSTERS.map((c) =>
		c.items.map((i) => `${CTRL}${i.key} ${i.label}`).join(" "),
	).join(`  ${DIVIDER}  `);

	const max = Math.max(16, viewportWidth - 2);

	// If we'd overflow, fall back to a truncated muted strip — readability beats
	// hierarchy when space runs out (iOS HIG: prefer clipping over reflow).
	if (plain.length > max) {
		return (
			<Box paddingX={1} flexShrink={0} overflow="hidden">
				<MutedText wrap="truncate-end">{truncate(plain, max)}</MutedText>
			</Box>
		);
	}

	return (
		<Box paddingX={1} flexDirection="row" flexShrink={0} overflow="hidden">
			{CLUSTERS.map((cluster, ci) => (
				<Box key={ci} flexDirection="row" flexShrink={0}>
					{ci > 0 && (
						<MutedText>
							{"  "}
							{DIVIDER}
							{"  "}
						</MutedText>
					)}
					{cluster.items.map((item, ii) => (
						<Box key={item.key} flexDirection="row" flexShrink={0}>
							{ii > 0 && <MutedText> </MutedText>}
							<AppText color="cyan" bold>
								{CTRL}
								{item.key}
							</AppText>
							<MutedText> {item.label}</MutedText>
						</Box>
					))}
				</Box>
			))}
		</Box>
	);
}
