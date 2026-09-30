/**
 * ContextRail - fixed-width left column for the three-zone TUI shell.
 *
 * Surfaces approval state, risk level, context pressure and ADHD mode. It
 * does not repeat the workspace or the branch: the header carries both
 * (audit 2026-09-30, #5). The shell mounts it only while approval or ADHD
 * mode is off its default (`contextRailHasNews`). Pure presentational: no internal state, no side effects,
 * no data fetching. Used by the wide-width shell layout and rendered to the
 * left of the message area + right inspector.
 *
 * Theme tokens only. No inline hex.
 *
 * Layout: section headings (STATE / CONTEXT / ACCESS) sit on their
 * own line in the calm heading tone, bold; orange is kept for state and focus. Data rows use the shared MetricRow helper so labels
 * and values can never collide at narrow widths (the bug that produced
 * `mainch` and `ASKroval`).
 */

import { Box, Text } from "ink";
import React from "react";
import { isPermissionMode } from "../../../../packages/permissions/permission-mode.js";
import { PERM_LOOK, permColour } from "../lib/perm-modes-design.js";
import { t } from "../theme.js";
import { MetricRow } from "./RailRow.js";

interface ContextRailProps {
	risk: "low" | "medium" | "high";
	permissions: string;
	contextPct: number;
	adhdMode: boolean;
}

export function ContextRail({
	risk,
	permissions,
	contextPct,
	adhdMode,
}: ContextRailProps) {
	// A permission mode (#3170) reads "perm <MODE>" in its colour.
	const permMode = isPermissionMode(permissions) ? permissions : undefined;
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
			<Text color={t.heading} bold>STATE</Text>
			{permMode ? (
				<MetricRow label="perm" value={PERM_LOOK[permMode].name.toUpperCase()} color={permColour(permMode)} />
			) : (
				<MetricRow
					label="approval"
					value={permissions.toUpperCase()}
					color={permissions === "ask" ? t.textPrimary : t.textSecondary}
				/>
			)}
			<MetricRow label="risk" value={risk.toUpperCase()} color={riskColor} />

			<Text color={t.dim}> </Text>
			<Text color={t.heading} bold>CONTEXT</Text>
			<Box justifyContent="space-between" width="100%" overflow="hidden">
				<Text color={t.steel}>{contextBar}</Text>
				<Text color={t.textSecondary}>{contextPct}%</Text>
			</Box>

			<Text color={t.dim}> </Text>
			<Text color={t.heading} bold>ACCESS</Text>
			<MetricRow
				label="ADHD"
				value={adhdMode ? "ON" : "OFF"}
				color={adhdMode ? t.teal : t.textSecondary}
			/>
		</Box>
	);
}

export type { ContextRailProps };
