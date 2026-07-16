/**
 * OrchestratorPane - the meta-harness orchestrator view (part of #2797).
 *
 * A live grid over the packages/harness StatusEvent stream: one row per
 * agent task, a state pill (queued/working/blocked/needs_input/done/error),
 * and the key fields the harness actually reported - harness name, current
 * tool, cumulative real tokens, wall-clock elapsed.
 *
 * Two layers:
 *   - OrchestratorPane: pure presentational, rows in, grid out. No state,
 *     no effects - same testing shape as ActivityRail.
 *   - OrchestratorPaneLive: subscribes to a StatusEventSource (the
 *     structural subset of HarnessRunner: allEvents + subscribe) via
 *     useHarnessTasks and feeds the pure pane.
 *
 * Honesty rules carried through from packages/harness/SPEC.md: a field the
 * agent loop never reported renders as "-", never a made-up number. Empty
 * grid says "no agents running" - no placeholder rows.
 *
 * Theme tokens only (t.*). State colors stay inside the brand palette; the
 * banned purple/pink/violet band is asserted in the test suite.
 */

import { Box, Text } from "ink";
import type React from "react";
import { type StatusEventSource, useHarnessTasks } from "../hooks/useHarnessTasks.js";
import { type OrchestratorRow, formatElapsed, formatTokens } from "../lib/orchestrator-model.js";
import { t } from "../theme.js";

/** Pill color per harness state. Brand palette only - no purple band. */
export const STATE_COLORS = {
	queued: t.steel,
	working: t.orange,
	blocked: t.orangeAlt,
	needs_input: t.teal,
	done: t.green,
	error: t.red,
} as const;

// Column widths. STATE fits " needs_input " (13); the rest favor the id and
// harness name, with truncate-end so narrow terminals degrade readably.
const COL = { id: 12, state: 13, harness: 13, tool: 13, tokens: 7, elapsed: 8 } as const;

function Cell({
	width,
	children,
}: {
	width: number;
	children: React.ReactNode;
}) {
	return (
		<Box width={width} flexShrink={0} marginRight={1} overflow="hidden">
			{children}
		</Box>
	);
}

function StatePill({ state }: { state: OrchestratorRow["state"] }) {
	return (
		<Text backgroundColor={STATE_COLORS[state]} color={t.bg} bold>
			{` ${state} `}
		</Text>
	);
}

function HeaderRow() {
	const cols: Array<[string, number]> = [
		["AGENT", COL.id],
		["STATE", COL.state],
		["HARNESS", COL.harness],
		["TOOL", COL.tool],
		["TOKENS", COL.tokens],
		["ELAPSED", COL.elapsed],
	];
	return (
		<Box width="100%">
			{cols.map(([label, width]) => (
				<Cell key={label} width={width}>
					<Text color={t.dim}>{label}</Text>
				</Cell>
			))}
		</Box>
	);
}

function TaskRow({ row }: { row: OrchestratorRow }) {
	return (
		<Box width="100%">
			<Cell width={COL.id}>
				<Text color={t.textPrimary} wrap="truncate-end">
					{row.id}
				</Text>
			</Cell>
			<Cell width={COL.state}>
				<StatePill state={row.state} />
			</Cell>
			<Cell width={COL.harness}>
				<Text color={t.textSecondary} wrap="truncate-end">
					{row.harness}
				</Text>
			</Cell>
			<Cell width={COL.tool}>
				<Text color={row.tool ? t.teal : t.dim} wrap="truncate-end">
					{row.tool ?? "-"}
				</Text>
			</Cell>
			<Cell width={COL.tokens}>
				<Text color={row.tokens !== undefined ? t.textSecondary : t.dim}>
					{formatTokens(row.tokens)}
				</Text>
			</Cell>
			<Cell width={COL.elapsed}>
				<Text color={row.elapsedMs !== undefined ? t.textSecondary : t.dim}>
					{formatElapsed(row.elapsedMs)}
				</Text>
			</Cell>
		</Box>
	);
}

export interface OrchestratorPaneProps {
	rows: OrchestratorRow[];
	/** Optional fixed width; defaults to filling the parent. */
	width?: number;
}

/** Pure orchestrator grid. Caller owns the rows; no internal state. */
export function OrchestratorPane({ rows, width }: OrchestratorPaneProps) {
	const active = rows.filter((r) => r.state !== "done" && r.state !== "error").length;
	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor={t.border}
			paddingX={1}
			{...(width !== undefined ? { width } : {})}
		>
			<Box width="100%" justifyContent="space-between">
				<Text color={t.orange} bold>
					ORCHESTRATOR
				</Text>
				{rows.length > 0 ? <Text color={t.dim}>{`${active} active`}</Text> : null}
			</Box>
			{rows.length === 0 ? (
				<Text color={t.dim}>no agents running</Text>
			) : (
				<Box flexDirection="column" width="100%">
					<HeaderRow />
					{rows.map((row) => (
						<TaskRow key={row.id} row={row} />
					))}
				</Box>
			)}
		</Box>
	);
}

export interface OrchestratorPaneLiveProps {
	/** In-process HarnessRunner (or any allEvents+subscribe source). */
	source?: StatusEventSource | null;
	width?: number;
}

/** Live orchestrator pane: folds the StatusEvent stream into the grid. */
export function OrchestratorPaneLive({ source, width }: OrchestratorPaneLiveProps) {
	const rows = useHarnessTasks(source);
	return <OrchestratorPane rows={rows} {...(width !== undefined ? { width } : {})} />;
}
