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
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
	return String(tokens);
}

/** "-" when never reported; 950 -> "950ms"; 4200 -> "4.2s"; 83000 -> "1m23s". */
export function formatElapsed(elapsedMs?: number): string {
	if (elapsedMs === undefined) return "-";
	if (elapsedMs < 1_000) return `${elapsedMs}ms`;
	if (elapsedMs < 60_000) return `${(elapsedMs / 1_000).toFixed(1)}s`;
	const minutes = Math.floor(elapsedMs / 60_000);
	const seconds = Math.round((elapsedMs % 60_000) / 1_000);
	return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}
