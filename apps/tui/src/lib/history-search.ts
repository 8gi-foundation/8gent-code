/**
 * /history search <words> and /history open <id> (#71).
 *
 * Pure parsing and formatting plus one small runner. The index itself lives in
 * packages/memory/session-index.ts. Everything stays on this machine.
 */

import type { Database } from "bun:sqlite";
import {
	type SessionHit,
	indexSessions,
	searchSessionTurns,
} from "../../../../packages/memory/session-index.js";

export type HistoryArgs =
	| { kind: "browse" }
	| { kind: "search"; query: string }
	| { kind: "open"; id: string }
	| { kind: "usage" };

/** No arguments keeps the existing session browser. */
export function parseHistoryArgs(args: string[]): HistoryArgs {
	if (args.length === 0) return { kind: "browse" };
	const [sub, ...rest] = args;
	const tail = rest.join(" ").trim();
	if (sub === "search" && tail) return { kind: "search", query: tail };
	if (sub === "open" && tail) return { kind: "open", id: tail };
	return { kind: "usage" };
}

export const HISTORY_USAGE = "Usage: /history  |  /history search <words>  |  /history open <id>";

/** The minimum of SessionManager this needs, so tests can hand in a fake. */
export interface SessionSource {
	list(limit?: number): Array<{ id: string; lastActiveAt: string }>;
	get(id: string): { messages: Array<{ role: string; content: string }> } | null;
}

/** Index anything new or grown (first use indexes everything), then search. */
export function runHistorySearch(
	db: Database,
	source: SessionSource,
	query: string,
	limit = 10,
): SessionHit[] {
	const sessions = source.list(100000).flatMap((s) => {
		const full = source.get(s.id);
		return full ? [{ id: s.id, lastActiveAt: s.lastActiveAt, messages: full.messages }] : [];
	});
	indexSessions(db, sessions);
	return searchSessionTurns(db, query, limit);
}

export function formatHits(query: string, hits: SessionHit[]): string {
	if (hits.length === 0) return `No past sessions match "${query}".`;
	const lines = hits.map((h, i) => `${i + 1}. ${h.date}  ${h.sessionId}  ${h.snippet}`);
	return `${hits.length} session${hits.length === 1 ? "" : "s"} match "${query}":\n${lines.join("\n")}\n\n/history open <id> resumes one.`;
}
