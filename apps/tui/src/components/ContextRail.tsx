/**
 * ContextRail - fixed-width left column for the three-zone TUI shell.
 *
 * Surfaces workspace, branch, approval state, risk level, context pressure,
 * and ADHD mode. Pure presentational: no internal state, no side effects,
 * no data fetching. Used by the wide-width shell layout and rendered to the
 * left of the message area + right inspector.
 *
 * Theme tokens only. No inline hex.
 *
 * Layout: section headings (WORKSPACE / STATE / CONTEXT / ACCESS) sit on their
 * own line in orange bold. Data rows use the shared MetricRow helper so labels
 * and values can never collide at narrow widths (the bug that produced
 * `mainch` and `ASKroval`).
 */

import { Box, Text } from "ink";
import React from "react";
import { t } from "../theme.js";
import { MetricRow } from "./RailRow.js";

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

	const filled = Math.max(0, Math.min(10, Math.round(contextPct / 10)));
	const empty = 10 - filled;
	const contextBar = "█".repeat(filled) + "░".repeat(empty);

	return (
		<Box
			width={28}
			flexShrink={0}
			borderStyle="single"
			borderColor={t.border}
			paddingX={1}
			flexDirection="column"
			overflow="hidden"
		>
			<Text color={t.orange} bold>WORKSPACE</Text>
			<Text color={t.textPrimary} wrap="truncate-end">{workspaceName}</Text>
			<MetricRow label="branch" value={branch} color={t.orange} />

			<Text color={t.dim}> </Text>
			<Text color={t.orange} bold>STATE</Text>
			<MetricRow
				label="approval"
				value={permissions.toUpperCase()}
				color={permissions === "ask" ? t.orange : t.textSecondary}
			/>
			<MetricRow label="risk" value={risk.toUpperCase()} color={riskColor} />

			<Text color={t.dim}> </Text>
			<Text color={t.orange} bold>CONTEXT</Text>
			<Box justifyContent="space-between" width="100%" overflow="hidden">
				<Text color={t.steel}>{contextBar}</Text>
				<Text color={t.textSecondary}>{contextPct}%</Text>
			</Box>

			<Text color={t.dim}> </Text>
			<Text color={t.orange} bold>ACCESS</Text>
			<MetricRow
				label="ADHD"
				value={adhdMode ? "ON" : "OFF"}
				color={adhdMode ? t.teal : t.textSecondary}
			/>
		</Box>
	);
}

export type { ContextRailProps };
