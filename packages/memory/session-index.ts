/**
 * Local full-text index over past session turns (#71).
 *
 * Lives in the same SQLite file as the memory store and uses the same FTS5
 * engine and porter tokenizer, but in its own tables, so session chatter never
 * shows up in agent memory recall. Nothing leaves the device.
 *
 * Input is plain data (id, date, messages) so this package does not depend on
 * the session store. Indexing is incremental: a session is re-read only when
 * its turn count changed since the last run.
 */

import type { Database } from "bun:sqlite";

export interface IndexableSession {
	id: string;
	lastActiveAt: string;
	messages: Array<{ role: string; content: string }>;
}

export interface SessionHit {
	sessionId: string;
	/** YYYY-MM-DD of the session's last activity. */
	date: string;
	role: string;
	snippet: string;
}

const SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS session_turns_fts USING fts5(
  body, session_id UNINDEXED, role UNINDEXED, tokenize='porter unicode61'
);
CREATE TABLE IF NOT EXISTS session_turns_state (
  session_id TEXT PRIMARY KEY,
  turn_count INTEGER NOT NULL,
  last_active TEXT NOT NULL
);`;

/** Index new or grown sessions. Returns the number of turns written. */
export function indexSessions(db: Database, sessions: IndexableSession[]): number {
	db.exec(SCHEMA);
	const state = db.prepare("SELECT turn_count FROM session_turns_state WHERE session_id = ?");
	const drop = db.prepare("DELETE FROM session_turns_fts WHERE session_id = ?");
	const add = db.prepare("INSERT INTO session_turns_fts (body, session_id, role) VALUES (?, ?, ?)");
	const mark = db.prepare(
		"INSERT OR REPLACE INTO session_turns_state (session_id, turn_count, last_active) VALUES (?, ?, ?)",
	);
	let written = 0;
	const run = db.transaction(() => {
		for (const s of sessions) {
			const seen = state.get(s.id) as { turn_count: number } | null;
			if (seen?.turn_count === s.messages.length) continue;
			drop.run(s.id);
			for (const m of s.messages) {
				add.run(m.content, s.id, m.role);
				written++;
			}
			mark.run(s.id, s.messages.length, s.lastActiveAt);
		}
	});
	run();
	return written;
}

/** Quote each word so user input can never be read as FTS5 syntax. */
function toMatch(query: string): string {
	return query
		.split(/\s+/)
		.map((w) => w.replace(/"/g, ""))
		.filter(Boolean)
		.map((w) => `"${w}"`)
		.join(" ");
}

/** Best turn per session, ranked by bm25, at most `limit` sessions. */
export function searchSessionTurns(db: Database, query: string, limit = 10): SessionHit[] {
	const match = toMatch(query);
	if (!match) return [];
	db.exec(SCHEMA);
	const rows = db
		.prepare(
			`SELECT f.session_id AS sessionId, f.role AS role, st.last_active AS lastActive,
			        snippet(session_turns_fts, 0, '[', ']', '...', 12) AS snippet
			 FROM session_turns_fts f
			 JOIN session_turns_state st ON st.session_id = f.session_id
			 WHERE session_turns_fts MATCH ?
			 ORDER BY bm25(session_turns_fts)
			 LIMIT ?`,
		)
		.all(match, limit * 20) as Array<{ sessionId: string; role: string; lastActive: string; snippet: string }>;
	const seen = new Set<string>();
	const hits: SessionHit[] = [];
	for (const r of rows) {
		if (seen.has(r.sessionId)) continue;
		seen.add(r.sessionId);
		hits.push({
			sessionId: r.sessionId,
			date: r.lastActive.slice(0, 10),
			role: r.role,
			snippet: r.snippet.replace(/\s+/g, " ").trim(),
		});
		if (hits.length === limit) break;
	}
	return hits;
}
