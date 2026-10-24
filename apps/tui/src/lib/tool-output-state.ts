/**
 * Which tool outputs are open (#4954). One small store, so Ctrl+O, a tap on a row and /out all act
 * on the same state without threading props through MessageList (rendered in three places).
 * Calls are named by their seq (lib/tool-trail.ts), the number a row's hint shows as "/out 12".
 */

import { useSyncExternalStore } from "react";
import type { ClickSpan } from "./click-targets.js";
import { type OutputView, outputBody, viewOutput } from "./tool-output.js";
import { entryBySeq, latestOutputEntry } from "./tool-trail.js";
import type { ToolTrailEntry } from "./tool-trail.js";

const open = new Set<number>();
const listeners = new Set<() => void>();
let version = 0;

function changed(): void {
	version++;
	for (const l of [...listeners]) l();
}

export function isOutputExpanded(seq: number): boolean {
	return open.has(seq);
}

/** Flip one call; returns whether it is now open. */
export function toggleOutput(seq: number): boolean {
	if (open.has(seq)) open.delete(seq);
	else open.add(seq);
	changed();
	return open.has(seq);
}

export function subscribeToolOutput(fn: () => void): () => void {
	listeners.add(fn);
	return () => {
		listeners.delete(fn);
	};
}

export function toolOutputVersion(): number {
	return version;
}

/** Re-render when any output opens or closes. */
export function useToolOutputVersion(): number {
	return useSyncExternalStore(subscribeToolOutput, toolOutputVersion, toolOutputVersion);
}

export function resetToolOutputForTests(): void {
	open.clear();
	listeners.clear();
	version = 0;
}

interface HasTrail {
	toolTrail?: ToolTrailEntry;
}

/** Ctrl+O: flip the newest call that has output. False when there is none. */
export function toggleLatestOutput(messages: readonly HasTrail[]): boolean {
	const e = latestOutputEntry(messages);
	if (!e || e.seq === undefined) return false;
	toggleOutput(e.seq);
	return true;
}

const USAGE = "Usage: /out [n]. Opens or closes the output of tool call n (the newest if no n).";

/** /out [n]: the phone's way to the same toggle. Returns the line to show. */
export function outCommand(args: string, messages: readonly HasTrail[]): string {
	const word = args.trim();
	let entry: ToolTrailEntry | undefined;
	let wanted: string;
	if (word === "") {
		entry = latestOutputEntry(messages);
		if (!entry) return "No tool output yet.";
		wanted = String(entry.seq);
	} else {
		const m = /^#?(\d+)$/.exec(word);
		if (!m) return USAGE;
		wanted = m[1];
		entry = entryBySeq(messages, Number(wanted));
		if (!entry) return `No tool output #${wanted}.`;
	}
	if (!entry.output || entry.seq === undefined) return `Tool call #${wanted} kept no output.`;
	return toggleOutput(entry.seq)
		? `Output of #${entry.seq} (${entry.tool}) is open. /out ${entry.seq} closes it.`
		: `Output of #${entry.seq} (${entry.tool}) is closed.`;
}

/** The part of a result row that decides its output block. */
export interface OutputRow {
	status: "ok" | "fail" | "blocked" | "pending";
	seq?: number;
	output?: string;
}

/** The block under a row at this width, and the rows it takes. Nothing when the row has no output. */
export function rowOutput(row: OutputRow, width: number): { view: OutputView; extraRows: number } {
	if (row.seq === undefined || !row.output)
		return { view: { lines: [], hint: null }, extraRows: 0 };
	const status = row.status === "fail" || row.status === "blocked" ? row.status : "ok";
	const view = viewOutput(outputBody(row.output, status), {
		status,
		expanded: isOutputExpanded(row.seq),
		width,
		seq: row.seq,
	});
	return { view, extraRows: view.lines.length + (view.hint ? 1 : 0) };
}

/** A tap on the row, or any of its output lines, flips that call. */
export function outputClickSpans(row: OutputRow, width: number): ClickSpan[] {
	const seq = row.seq;
	if (seq === undefined || !row.output) return [];
	return [
		{
			id: `tool-out:${seq}`,
			dx: 0,
			w: width,
			h: 1 + rowOutput(row, width).extraRows,
			action: () => void toggleOutput(seq),
		},
	];
}

/** Extra rows the output blocks of these rows take, for the list's row estimate. */
export function outputExtraRows(rows: readonly OutputRow[], width: number): number {
	return rows.reduce((n, r) => n + rowOutput(r, width).extraRows, 0);
}
