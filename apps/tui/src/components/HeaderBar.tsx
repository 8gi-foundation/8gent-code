/**
 * HeaderBar — top-of-frame brand row.
 *
 * Renders the rounded BrandPill on the left and `^T:new ^W:close`
 * shortcuts on the right. The actual tab strip lives in <TabBar/>
 * directly below; we don't render tabs here so we can preserve TabBar's
 * live data, switching logic, and per-tab busy indicators.
 *
 * Flex rules per Ink layout: BrandPill never shrinks; the spacer between
 * brand and shortcuts owns the slack via flexGrow=1.
 */

import { Box, Text } from "ink";
import React from "react";
import { theme } from "../theme.js";

const ui = {
	cream: theme.color.cream,
	muted: theme.color.muted,
	dim: theme.color.dim,
	orange: theme.color.orange,
	teal: theme.color.teal,
	cyan: "#00D7E8",
	red: theme.color.red,
	green: "#47A639",
	pillBorder: "#00D7E8",
} as const;

interface HeaderBarProps {
	updateAvailable?: { latest: string; current: string } | null;
}

export function HeaderBar({ updateAvailable }: HeaderBarProps) {
	return (
		<Box width="100%" justifyContent="space-between" alignItems="center" flexShrink={0}>
			<BrandPill updateAvailable={updateAvailable} />
			<Box flexShrink={0}>
				<Text color={ui.muted}>^T:new  ^W:close</Text>
			</Box>
		</Box>
	);
}

function BrandPill({
	updateAvailable,
}: {
	updateAvailable?: { latest: string; current: string } | null;
}) {
	return (
		<Box borderStyle="round" borderColor={ui.pillBorder} paddingX={1} flexShrink={0}>
			<BrandWord />
			<Text color={ui.dim}> Code </Text>
			<Text color={ui.dim}>│</Text>
			<Text color={ui.muted}> The Infinite </Text>
			<Text color={ui.teal}>Gentleman</Text>
			{updateAvailable ? (
				<>
					<Text color={ui.dim}>  │ </Text>
					<Text color={ui.orange}>↑ v{updateAvailable.latest}</Text>
				</>
			) : null}
		</Box>
	);
}

function BrandWord() {
	return (
		<Box flexShrink={0}>
			<Text color={ui.cream} bold>
				8
			</Text>
			<Text color={ui.orange} bold>
				g
			</Text>
			<Text color={ui.cyan} bold>
				e
			</Text>
			<Text color={ui.green} bold>
				n
			</Text>
			<Text color={ui.red} bold>
				t
			</Text>
		</Box>
	);
}
