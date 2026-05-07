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
 * own line in orange bold. Sub-labels share a row with their value so narrow
 * widths don't wrap and clip leading characters. Values use truncate-end so
 * long branch names don't break the rail.
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

/**
 * Inline label + value row. Label takes its natural width, value takes the
 * remaining space and truncates from the end if too long.
 */
function Row({
	label,
	value,
	valueColor,
}: {
	label: string;
	value: string;
	valueColor: string;
}) {
	return (
		<Box flexDirection="row">
			<Text color={t.dim}>{label}  </Text>
			<Box flexGrow={1}>
				<Text color={valueColor} wrap="truncate-end">{value}</Text>
			</Box>
		</Box>
	);
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
			<Text color={t.textSecondary} wrap="truncate-end">{workspaceName}</Text>
			<Row label="branch" value={branch} valueColor={t.orange} />

			<Text color={t.dim}> </Text>
			<Text color={t.orange} bold>STATE</Text>
			<Row
				label="approval"
				value={permissions.toUpperCase()}
				valueColor={permissions === "ask" ? t.orange : t.textSecondary}
			/>
			<Row label="risk" value={risk.toUpperCase()} valueColor={riskColor} />

			<Text color={t.dim}> </Text>
			<Text color={t.orange} bold>CONTEXT</Text>
			<Box flexDirection="row">
				<Text color={t.steel}>{contextBar}</Text>
				<Text color={t.muted}> {contextPct}%</Text>
			</Box>

			<Text color={t.dim}> </Text>
			<Text color={t.orange} bold>ACCESS</Text>
			<Row
				label="ADHD"
				value={adhdMode ? "ON" : "OFF"}
				valueColor={adhdMode ? t.teal : t.muted}
			/>
		</Box>
	);
}

export type { ContextRailProps };
