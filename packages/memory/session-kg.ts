/**
 * Session Knowledge Graph — write session summaries, recall prior sessions.
 *
 * Writes Session/File/Person entities to the global memory DB at session close.
 * Provides a sync recall function for system-prompt injection at session open.
 *
 * All operations are best-effort: never throws, never blocks cleanup.
 */

import * as os from "node:os";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import { KnowledgeGraph } from "./graph.js";

const GLOBAL_DB_PATH = path.join(
	process.env.EIGHT_DATA_DIR || path.join(os.homedir(), ".8gent"),
	"memory",
	"memory.db",
);

// ── Person extraction ─────────────────────────────────────────────────

const PERSON_RE = /\b([A-Z][a-z]{1,20}(?:\s[A-Z][a-z]{1,20})+)\b/g;
const SKIP_NAMES = new Set([
	"Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
	"January", "February", "March", "April", "May", "June", "July",
	"August", "September", "October", "November", "December",
	"TypeScript", "JavaScript", "GitHub", "GitLab", "Vercel", "Convex",
	"Claude Code", "Visual Studio", "New York", "Los Angeles", "San Francisco",
]);

function extractPeople(text: string): string[] {
	const found = new Set<string>();
	for (const [, name] of text.matchAll(PERSON_RE)) {
		if (!SKIP_NAMES.has(name)) found.add(name);
	}
	return [...found].slice(0, 8);
}

// ── Session summary heuristic ─────────────────────────────────────────

type MsgHistory = Array<{ role: string; content: string | unknown }>;

export function generateSessionSummary(messages: MsgHistory, filesModified: string[]): string {
	const userMessages = messages
		.filter((m) => m.role === "user" && typeof m.content === "string")
		.map((m) => (m.content as string).slice(0, 200));

	const firstTask = userMessages[0] || "";
	const fileList =
		filesModified.length > 0
			? ` Touched: ${filesModified.slice(0, 5).map((f) => path.basename(f)).join(", ")}${filesModified.length > 5 ? "..." : ""}.`
			: "";

	return `${firstTask.trim()}.${fileList}`.slice(0, 500);
}

// ── KG write at session close ─────────────────────────────────────────

export interface SessionKGInput {
	sessionId: string;
	summary: string;
	cwd: string;
	filesCreated: Set<string> | string[];
	filesModified: Set<string> | string[];
	durationMs: number;
	branch?: string | null;
}

export async function writeSessionToKG(input: SessionKGInput): Promise<void> {
	try {
		const dir = path.dirname(GLOBAL_DB_PATH);
		const { mkdirSync } = await import("node:fs");
		mkdirSync(dir, { recursive: true });

		const db = new Database(GLOBAL_DB_PATH, { create: true });
		db.run("PRAGMA journal_mode=WAL");
		const kg = new KnowledgeGraph(db);

		const { sessionId, summary, cwd, filesCreated, filesModified, durationMs, branch } = input;
		const repo = path.basename(cwd);
		const now = Date.now();

		const sessionId_ = kg.addEntity("session", sessionId, {
			description: summary,
			metadata: { cwd, repo, branch: branch ?? null, durationMs, timestamp: now },
		});

		const allFiles = [...new Set([...filesCreated, ...filesModified])].filter(Boolean);
		for (const filePath of allFiles) {
			const fileId = kg.addEntity("file", filePath, {
				description: `File in ${repo}`,
				metadata: { repo, cwd, lastSeen: now },
			});
			kg.addRelationship(sessionId_, fileId, "contains");
		}

		for (const name of extractPeople(summary)) {
			const personId = kg.addEntity("person", name, {
				metadata: { mentionedIn: sessionId, mentionedAt: now },
			});
			kg.addRelationship(sessionId_, personId, "related_to");
		}

		db.close();
	} catch {
		// best-effort
	}
}

// ── Sync recall for system-prompt injection ───────────────────────────

export function recallPriorSessionsSync(cwd: string, limit = 3): string {
	try {
		const { existsSync } = require("node:fs") as typeof import("node:fs");
		if (!existsSync(GLOBAL_DB_PATH)) return "";

		const db = new Database(GLOBAL_DB_PATH);
		db.run("PRAGMA journal_mode=WAL");

		const repo = path.basename(cwd);
		const rows = db
			.query<{ description: string; metadata: string; last_seen: number }, [string, string]>(
				`SELECT description, metadata, last_seen
         FROM knowledge_entities
         WHERE type = 'session'
           AND (metadata LIKE ? OR metadata LIKE ?)
         ORDER BY last_seen DESC
         LIMIT ${limit}`,
			)
			.all(`%"cwd":"${cwd}"%`, `%"repo":"${repo}"%`);

		db.close();

		if (rows.length === 0) return "";

		const lines = rows.map((row) => {
			const meta = JSON.parse(row.metadata || "{}") as Record<string, unknown>;
			const date = new Date(row.last_seen).toLocaleDateString("en-IE", {
				weekday: "short",
				month: "short",
				day: "numeric",
			});
			const branchSuffix = meta.branch ? ` [${meta.branch}]` : "";
			return `- ${date}${branchSuffix}: ${(row.description || "(no summary)").slice(0, 200)}`;
		});

		return `\n\n## Prior sessions in this repo\n${lines.join("\n")}`;
	} catch {
		return "";
	}
}
