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
 * Space behavior (#2802): the grid caps at maxRows visible rows (active
 * tasks kept first) with an honest "+N more" line, and columns drop
 * responsively via layoutColumns() when the pane is narrower than the full
 * six-column budget - AGENT and STATE always survive.
 *
 * Theme tokens only (t.*). State colors stay inside the brand palette; the
 * banned purple/pink/violet band is asserted in the test suite.
 */

import { Box, Text, useStdout } from "ink";
import type React from "react";
import { type StatusEventSource, useHarnessTasks } from "../hooks/useHarnessTasks.js";
import {
	type ColumnSpec,
	type OrchestratorRow,
	formatElapsed,
	formatTokens,
	layoutColumns,
	selectVisibleRows,
} from "../lib/orchestrator-model.js";
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

/** Default visible-row cap; override per embed via the maxRows prop. */
export const DEFAULT_MAX_ROWS = 10;

/** Fallback pane width when neither a width prop nor stdout.columns exists. */
const FALLBACK_WIDTH = 80;

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

function HeaderRow({ columns }: { columns: ColumnSpec[] }) {
	return (
		<Box width="100%">
			{columns.map((col) => (
				<Cell key={col.key} width={col.width}>
					<Text color={t.dim}>{col.label}</Text>
				</Cell>
			))}
		</Box>
	);
}

function cellContent(row: OrchestratorRow, key: ColumnSpec["key"]): React.ReactNode {
	switch (key) {
		case "id":
			return (
				<Text color={t.textPrimary} wrap="truncate-end">
					{row.id}
				</Text>
			);
		case "state":
			return <StatePill state={row.state} />;
		case "harness":
			return (
				<Text color={t.textSecondary} wrap="truncate-end">
					{row.harness}
				</Text>
			);
		case "tool":
			return (
				<Text color={row.tool ? t.teal : t.dim} wrap="truncate-end">
					{row.tool ?? "-"}
				</Text>
			);
		case "tokens":
			return (
				<Text color={row.tokens !== undefined ? t.textSecondary : t.dim}>
					{formatTokens(row.tokens)}
				</Text>
			);
		case "elapsed":
			return (
				<Text color={row.elapsedMs !== undefined ? t.textSecondary : t.dim}>
					{formatElapsed(row.elapsedMs)}
				</Text>
			);
	}
}

function TaskRow({ row, columns }: { row: OrchestratorRow; columns: ColumnSpec[] }) {
	return (
		<Box width="100%">
			{columns.map((col) => (
				<Cell key={col.key} width={col.width}>
					{cellContent(row, col.key)}
				</Cell>
			))}
		</Box>
	);
}

export interface OrchestratorPaneProps {
	rows: OrchestratorRow[];
	/** Optional fixed width; defaults to the terminal width (stdout.columns). */
	width?: number;
	/** Visible-row cap before the "+N more" line. Default DEFAULT_MAX_ROWS. */
	maxRows?: number;
}

/** Pure orchestrator grid. Caller owns the rows; no internal state. */
export function OrchestratorPane({ rows, width, maxRows }: OrchestratorPaneProps) {
	const { stdout } = useStdout();
	const paneWidth = width ?? stdout?.columns ?? FALLBACK_WIDTH;
	const columns = layoutColumns(paneWidth);
	const { visible, hidden } = selectVisibleRows(rows, maxRows ?? DEFAULT_MAX_ROWS);
	const active = rows.filter((r) => r.state !== "done" && r.state !== "error").length;
	const activeLabel = `${active} active`;
	// Drop the count rather than mash it into the title on tiny panes
	// (paneWidth - border/padding must fit title + one space + count).
	const showActive =
		rows.length > 0 && paneWidth - 4 >= "ORCHESTRATOR".length + 1 + activeLabel.length;
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
				{showActive ? <Text color={t.dim}>{activeLabel}</Text> : null}
			</Box>
			{rows.length === 0 ? (
				<Text color={t.dim}>no agents running</Text>
			) : (
				<Box flexDirection="column" width="100%">
					<HeaderRow columns={columns} />
					{visible.map((row) => (
						<TaskRow key={row.id} row={row} columns={columns} />
					))}
					{hidden > 0 ? <Text color={t.dim}>{`+${hidden} more`}</Text> : null}
				</Box>
			)}
		</Box>
	);
}

export interface OrchestratorPaneLiveProps {
	/** In-process HarnessRunner (or any allEvents+subscribe source). */
	source?: StatusEventSource | null;
	width?: number;
	maxRows?: number;
}

/** Live orchestrator pane: folds the StatusEvent stream into the grid. */
export function OrchestratorPaneLive({ source, width, maxRows }: OrchestratorPaneLiveProps) {
	const rows = useHarnessTasks(source);
	return (
		<OrchestratorPane
			rows={rows}
			{...(width !== undefined ? { width } : {})}
			{...(maxRows !== undefined ? { maxRows } : {})}
		/>
	);
}
