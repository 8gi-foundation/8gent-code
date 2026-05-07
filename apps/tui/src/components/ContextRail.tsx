/**
 * ContextRail - fixed-width left column for the three-zone TUI shell.
 *
 * Surfaces workspace, branch, approval state, risk level, context pressure,
 * and ADHD mode. Pure presentational: no internal state, no side effects,
 * no data fetching. Used by the wide-width shell layout and rendered to the
 * left of the message area + right inspector.
 *
 * Theme tokens only. No inline hex.
 */

import { Box, Text } from "ink";
import React from "react";
import { t } from "../theme.js";

interface ContextRailProps {
	branch: string;
	risk: "low" | "medium" | "high";
	permissions: string;
	contextPct: number;
	adhdMode: boolean;
	/** Optional override; defaults to "8gent-code" until wired to real workspace. */
	workspaceName?: string;
}

export function ContextRail({
	branch,
	risk,
	permissions,
	contextPct,
	adhdMode,
	workspaceName = "8gent-code",
}: ContextRailProps) {
	const riskColor =
		risk === "high" ? t.red : risk === "medium" ? t.orange : t.green;

	const contextBlocks = "█".repeat(Math.max(0, Math.min(10, Math.round(contextPct / 10))));

	return (
		<Box
			width={24}
			flexShrink={0}
			borderStyle="single"
			borderColor={t.border}
			paddingX={1}
			flexDirection="column"
			overflow="hidden"
		>
			<Text color={t.orange} bold>WORKSPACE</Text>
			<Text color={t.textSecondary} wrap="truncate-end">{workspaceName}</Text>
			<Text color={t.dim}>branch</Text>
			<Text color={t.orange} wrap="truncate-end">{branch}</Text>

			<Text color={t.dim}> </Text>
			<Text color={t.orange} bold>STATE</Text>
			<Text color={t.dim}>approval</Text>
			<Text color={permissions === "ask" ? t.orange : t.textSecondary}>
				{permissions.toUpperCase()}
			</Text>
			<Text color={t.dim}>risk</Text>
			<Text color={riskColor}>{risk.toUpperCase()}</Text>

			<Text color={t.dim}> </Text>
			<Text color={t.orange} bold>CONTEXT</Text>
			<Text color={t.steel}>{contextBlocks}</Text>
			<Text color={t.muted}>{contextPct}% used</Text>

			<Text color={t.dim}> </Text>
			<Text color={t.orange} bold>ACCESS</Text>
			<Text color={adhdMode ? t.teal : t.muted}>
				ADHD {adhdMode ? "ON" : "OFF"}
			</Text>
		</Box>
	);
}

export type { ContextRailProps };
