/**
 * orchestrator-model - pure fold from the meta-harness StatusEvent stream
 * (packages/harness, part of #2797) to one display row per agent task.
 *
 * Honesty rules (mirrors packages/harness/SPEC.md): tool, tokens, elapsedMs
 * and output on a row are only ever values a real StatusEvent carried. An
 * event that omits a field never erases the last reported value, and no
 * field is ever synthesised here. The pane renders "-" for never-reported
 * fields; that decision lives in the formatters below.
 *
 * The fold is idempotent per event (rows are keyed by agentId), which lets
 * the subscribe-then-replay wiring in useHarnessTasks tolerate the same
 * event appearing in both the buffered history and the live feed.
 */

import type { HarnessState, StatusEvent } from "../../../../packages/harness/index";

export interface OrchestratorRow {
	/** Task id (StatusEvent.agentId). */
	id: string;
	/** Registered harness name, e.g. "8gent-local". */
	harness: string;
	state: HarnessState;
	/** Last tool the agent loop actually reported. */
	tool?: string;
	/** Last cumulative REAL token count reported (usage.totalTokens). */
	tokens?: number;
	/** Last wall-clock elapsed the harness reported. */
	elapsedMs?: number;
	/** Final response (done) or error message (error), when reported. */
	output?: string;
	/** ts of the first event seen for this task. */
	startedTs: number;
	/** ts of the most recent event seen for this task. */
	updatedTs: number;
}

/** Fold one StatusEvent into the row list. Pure - returns a new array. */
export function foldStatusEvent(
	rows: readonly OrchestratorRow[],
	event: StatusEvent,
): OrchestratorRow[] {
	const index = rows.findIndex((r) => r.id === event.agentId);
	if (index === -1) {
		return [...rows, rowFromEvent(event)];
	}
	const existing = rows[index] as OrchestratorRow;
	const next = [...rows];
	next[index] = {
		...existing,
		state: event.state,
		updatedTs: event.ts,
		// Only overwrite with values the event actually carried.
		...(event.tool !== undefined ? { tool: event.tool } : {}),
		...(event.tokens !== undefined ? { tokens: event.tokens } : {}),
		...(event.elapsedMs !== undefined ? { elapsedMs: event.elapsedMs } : {}),
		...(event.output !== undefined ? { output: event.output } : {}),
	};
	return next;
}

/** Fold a buffered event history (oldest first) into rows. */
export function foldStatusEvents(events: readonly StatusEvent[]): OrchestratorRow[] {
	let rows: OrchestratorRow[] = [];
	for (const event of events) rows = foldStatusEvent(rows, event);
	return rows;
}

function rowFromEvent(event: StatusEvent): OrchestratorRow {
	return {
		id: event.agentId,
		harness: event.harness,
		state: event.state,
		startedTs: event.ts,
		updatedTs: event.ts,
		...(event.tool !== undefined ? { tool: event.tool } : {}),
		...(event.tokens !== undefined ? { tokens: event.tokens } : {}),
		...(event.elapsedMs !== undefined ? { elapsedMs: event.elapsedMs } : {}),
		...(event.output !== undefined ? { output: event.output } : {}),
	};
}

/** "-" when never reported; 950 -> "950"; 12345 -> "12.3k"; 2.4e6 -> "2.4M". */
export function formatTokens(tokens?: number): string {
	if (tokens === undefined) return "-";
	if (tokens >= 1_000) {
		const thousands = tokens / 1_000;
		// #2801: values whose k display would round to "1000.0k" belong in M.
		// Covers everything >= 1M too, so one threshold handles the boundary.
		if (thousands >= 999.95) return `${(tokens / 1_000_000).toFixed(1)}M`;
		return `${thousands.toFixed(1)}k`;
	}
	return String(tokens);
}

/** "-" when never reported; 950 -> "950ms"; 4200 -> "4.2s"; 83000 -> "1m23s". */
export function formatElapsed(elapsedMs?: number): string {
	if (elapsedMs === undefined) return "-";
	if (elapsedMs < 1_000) return `${elapsedMs}ms`;
	const seconds = elapsedMs / 1_000;
	// #2801: values whose s display would round to "60.0s" belong in m/s.
	if (seconds < 59.95) return `${seconds.toFixed(1)}s`;
	// Round the whole value to seconds FIRST, then split - the seconds
	// remainder can never be 60, so "1m60s" is impossible by construction.
	const totalSeconds = Math.round(seconds);
	const minutes = Math.floor(totalSeconds / 60);
	const secs = totalSeconds % 60;
	return `${minutes}m${String(secs).padStart(2, "0")}s`;
}

// ---------------------------------------------------------------------------
// Responsive layout + row cap (#2802). Pure helpers so the pane's sizing
// behavior is testable without a terminal.
// ---------------------------------------------------------------------------

export interface ColumnSpec {
	key: "id" | "state" | "harness" | "tool" | "tokens" | "elapsed";
	label: string;
	width: number;
}

/** Full column set in display order. STATE fits " needs_input " (13). */
const FULL_COLUMNS: readonly ColumnSpec[] = [
	{ key: "id", label: "AGENT", width: 12 },
	{ key: "state", label: "STATE", width: 13 },
	{ key: "harness", label: "HARNESS", width: 13 },
	{ key: "tool", label: "TOOL", width: 13 },
	{ key: "tokens", label: "TOKENS", width: 7 },
	{ key: "elapsed", label: "ELAPSED", width: 8 },
];

/** Drop order priority: id and state always survive, elapsed next. */
const PRIORITY: ReadonlyArray<ColumnSpec["key"]> = [
	"id",
	"state",
	"elapsed",
	"harness",
	"tool",
	"tokens",
];

/** Border (2) + paddingX (2) of the pane box. */
const PANE_CHROME = 4;
const MIN_ID_WIDTH = 4;

/**
 * Pick the columns that actually fit a pane of `paneWidth` total columns.
 * Takes the largest prefix of PRIORITY that fits (each column costs
 * width + 1 margin), returned in display order. AGENT + STATE always
 * survive; AGENT shrinks (down to MIN_ID_WIDTH) when even they do not fit.
 */
export function layoutColumns(paneWidth: number): ColumnSpec[] {
	const available = paneWidth - PANE_CHROME;
	const byKey = new Map(FULL_COLUMNS.map((c) => [c.key, c]));
	const picked = new Set<ColumnSpec["key"]>();
	let used = 0;
	for (const key of PRIORITY) {
		const col = byKey.get(key) as ColumnSpec;
		if (used + col.width + 1 <= available) {
			picked.add(key);
			used += col.width + 1;
		} else if (key === "id" || key === "state") {
			// Floor: keep AGENT + STATE, shrinking AGENT to make room.
			picked.add(key);
			used += col.width + 1;
		} else {
			break; // prefix semantics - no gaps in the drop order
		}
	}
	const cols = FULL_COLUMNS.filter((c) => picked.has(c.key)).map((c) => ({ ...c }));
	if (used > available) {
		const id = cols.find((c) => c.key === "id");
		const state = byKey.get("state") as ColumnSpec;
		if (id) id.width = Math.max(MIN_ID_WIDTH, available - (state.width + 1) - 1);
	}
	return cols;
}

/**
 * Cap the grid at `maxRows` visible rows. Active (non-terminal) rows are
 * kept over older done/error rows; whatever is shown keeps display order.
 * Returns the hidden count for the honest "+N more" line.
 */
export function selectVisibleRows(
	rows: readonly OrchestratorRow[],
	maxRows: number,
): { visible: OrchestratorRow[]; hidden: number } {
	if (maxRows <= 0 || rows.length <= maxRows) {
		return { visible: [...rows], hidden: 0 };
	}
	const indexed = rows.map((row, index) => ({ row, index }));
	const isActive = (r: OrchestratorRow) => r.state !== "done" && r.state !== "error";
	const active = indexed.filter(({ row }) => isActive(row));
	const terminal = indexed.filter(({ row }) => !isActive(row));
	const picked = active.slice(0, maxRows);
	const remaining = maxRows - picked.length;
	// Fill leftover slots with the most recent terminal rows.
	if (remaining > 0) picked.push(...terminal.slice(-remaining));
	picked.sort((a, b) => a.index - b.index);
	return {
		visible: picked.map(({ row }) => row),
		hidden: rows.length - picked.length,
	};
}
