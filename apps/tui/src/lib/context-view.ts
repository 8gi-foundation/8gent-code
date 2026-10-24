/**
 * What the window holds, for the footer meter and /context (#4956).
 *
 * Pure and local: sizes come from the message history the agent already has,
 * counted with the compactor's own estimate, so /context and the compaction
 * trigger never disagree about a message.
 */

import { estimateMessageTokens } from "../../../../packages/eight/compaction.js";

/** Tokens as people read them: 842, 3.1k, 31.2k, 128k, 1.2M. */
export function fmtTokens(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0";
	if (n < 1000) return String(Math.round(n));
	if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** The colour step of the meter: calm, warn from 70 percent, danger from 90. */
export type CtxLevel = "ok" | "warn" | "danger";
export function ctxLevel(pct: number): CtxLevel {
	return pct >= 90 ? "danger" : pct >= 70 ? "warn" : "ok";
}

export interface CtxInput {
	/** Tokens in the window at the last measured step; null before one. */
	used: number | null;
	/** The window, or null when it is not known. */
	window: number | null;
	/** A compaction just ran and no turn has measured since: the old number is stale. */
	stale: boolean;
	/** Terminal columns: below 60 the segment keeps only the percent. */
	columns: number;
}

export interface CtxText {
	value: string;
	level: CtxLevel | "stale";
}

/**
 * The footer segment's value, or null when there is nothing honest to show
 * (no measurement yet and no compaction). Never a percent without a window.
 */
export function ctxText(i: CtxInput): CtxText | null {
	const narrow = i.columns < 60;
	if (i.stale) {
		return {
			value: narrow || i.window === null ? "?" : `?/${fmtTokens(i.window)}`,
			level: "stale",
		};
	}
	if (i.used === null || i.used <= 0) return null;
	if (i.window === null || i.window <= 0) return { value: fmtTokens(i.used), level: "ok" };
	const pct = Math.min(100, Math.round((i.used / i.window) * 100));
	const level = ctxLevel(pct);
	// The bang repeats the danger colour for a terminal with none.
	const bang = level === "danger" ? "!" : "";
	return {
		value: narrow ? `${pct}%${bang}` : `${pct}%${bang} ${fmtTokens(i.used)}/${fmtTokens(i.window)}`,
		level,
	};
}

export type ContextPart = "system" | "notes" | "history" | "tools";

export interface ContextRow {
	part: ContextPart;
	label: string;
	messages: number;
	tokens: number;
}

const NOTE_HEADER = "[Session context from the harness";

/**
 * Sort the history into the four things a person asks about: the system
 * prompt, the harness notes injected as messages, the conversation, and tool
 * output. Rows keep that order and are always all present.
 */
export function classifyContext(
	history: ReadonlyArray<{ role: string; content: string }>,
): ContextRow[] {
	const buckets: Record<ContextPart, Array<{ role: string; content: string }>> = {
		system: [],
		notes: [],
		history: [],
		tools: [],
	};
	for (const m of history) {
		if (m.role === "system") buckets.system.push(m);
		else if (m.role === "tool") buckets.tools.push(m);
		else if (
			m.role === "user" &&
			(m.content.startsWith(NOTE_HEADER) || m.content.startsWith("[harness]"))
		)
			buckets.notes.push(m);
		else buckets.history.push(m);
	}
	const label: Record<ContextPart, string> = {
		system: "system prompt",
		notes: "harness notes",
		history: "conversation",
		tools: "tool output",
	};
	return (["system", "notes", "history", "tools"] as const).map((part) => ({
		part,
		label: label[part],
		messages: buckets[part].length,
		tokens: estimateMessageTokens(buckets[part] as never),
	}));
}

/**
 * The /context report: one line per part, then the total against the window.
 * Lines stay under 40 columns so a phone never wraps one mid-word.
 */
export function formatContextReport(
	rows: ContextRow[],
	window: number | null,
	opts: { measured?: number | null; stale?: boolean } = {},
): string {
	const total = rows.reduce((s, r) => s + r.tokens, 0);
	const pad = Math.max(...rows.map((r) => r.label.length));
	const lines = rows.map((r) => {
		const share = total > 0 ? Math.round((r.tokens / total) * 100) : 0;
		return `${r.label.padEnd(pad)}  ${fmtTokens(r.tokens).padStart(6)}  ${String(share).padStart(3)}%`;
	});
	const of = window ? ` of ${fmtTokens(window)}` : "";
	const pct = window && total > 0 ? ` (${Math.min(100, Math.round((total / window) * 100))}%)` : "";
	lines.push(`${"total".padEnd(pad)}  ${fmtTokens(total).padStart(6)}  est${of}${pct}`);
	if (opts.stale) lines.push("A compaction just ran: the meter reads ? until the next turn.");
	else if (opts.measured && opts.measured > 0)
		lines.push(`Last measured turn: ${fmtTokens(opts.measured)} tokens.`);
	lines.push("/stack lists what the next turn sends, source by source.");
	return lines.join("\n");
}
