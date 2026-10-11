/**
 * SessionManager - Named session management with local JSON persistence.
 *
 * Sessions are stored as JSON files in ~/.8gent/sessions/{id}.json.
 * Each file contains SessionInfo metadata + serialized messages.
 * Supports naming, listing (sorted by recency), and fuzzy resume by name or ID.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface SessionInfo {
	id: string;
	name?: string;
	model: string;
	provider: string;
	cwd: string;
	branch?: string;
	messageCount: number;
	createdAt: string;
	lastActiveAt: string;
	/** Surface that owns it when shared through the daemon ("tui", "browser", ...). */
	channel?: string;
}

/** Ids become file names: only plain ids are ever read or written by id. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isSessionId(v: unknown): v is string {
	return typeof v === "string" && SESSION_ID_PATTERN.test(v);
}

interface SessionFile extends SessionInfo {
	messages: Array<{ role: string; content: string }>;
}

export class SessionManager {
	private dir: string;

	constructor(dataDir?: string) {
		this.dir = dataDir || path.join(process.env.HOME || "~", ".8gent", "sessions");
		fs.mkdirSync(this.dir, { recursive: true });
	}

	/** Create a new session and persist it. */
	create(opts?: {
		name?: string;
		model?: string;
		provider?: string;
		cwd?: string;
		branch?: string;
	}): SessionInfo {
		const now = new Date().toISOString();
		const info: SessionInfo = {
			id: randomUUID().slice(0, 8),
			name: opts?.name,
			model: opts?.model || "unknown",
			provider: opts?.provider || "ollama",
			cwd: opts?.cwd || process.cwd(),
			branch: opts?.branch,
			messageCount: 0,
			createdAt: now,
			lastActiveAt: now,
		};
		const file: SessionFile = { ...info, messages: [] };
		this.write(info.id, file);
		return info;
	}

	/** Resume a session by exact ID or name prefix match. Returns null if not found. */
	resume(
		nameOrId: string,
	): (SessionInfo & { messages: Array<{ role: string; content: string }> }) | null {
		const needle = nameOrId.toLowerCase();

		// Try exact ID match first
		const byId = isSessionId(needle) ? this.readFile(needle) : null;
		if (byId) return byId;

		// Scan all sessions for name prefix match
		const all = this.listAll();
		const match = all.find(
			(s) => s.name?.toLowerCase().startsWith(needle) || s.id.startsWith(needle),
		);
		if (!match) return null;

		return this.readFile(match.id);
	}

	/** List sessions sorted by lastActiveAt descending. */
	list(limit = 20): SessionInfo[] {
		return this.listAll()
			.sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime())
			.slice(0, limit);
	}

	/** Read one session by exact id (no name matching). Null when absent or the id is not plain. */
	get(id: string): (SessionInfo & { messages: Array<{ role: string; content: string }> }) | null {
		if (!isSessionId(id)) return null;
		return this.readFile(id);
	}

	/**
	 * Write a session's messages, creating the file when it does not exist yet
	 * (a daemon session the store has never seen). Keeps the name and createdAt
	 * of an existing file.
	 */
	save(
		id: string,
		messages: Array<{ role: string; content: string }>,
		meta: Partial<Pick<SessionInfo, "model" | "provider" | "branch" | "cwd" | "channel">> = {},
	): void {
		if (!isSessionId(id)) throw new Error(`invalid session id: ${id}`);
		const now = new Date().toISOString();
		const prev = this.readFile(id);
		const file: SessionFile = {
			...(prev ?? {
				id,
				model: "unknown",
				provider: "unknown",
				cwd: meta.cwd || process.cwd(),
				createdAt: now,
			}),
			...Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined)),
			id,
			messages,
			messageCount: messages.length,
			lastActiveAt: now,
		} as SessionFile;
		this.write(id, file);
	}

	/** Rename a session. */
	rename(id: string, name: string): void {
		const file = this.readFile(id);
		if (!file) return;
		file.name = name;
		this.write(id, file);
	}

	/** Get the most recently active session. */
	getLast(): SessionInfo | null {
		const sessions = this.list(1);
		return sessions[0] || null;
	}

	/** Update session with new messages and touch lastActiveAt. */
	update(
		id: string,
		messages: Array<{ role: string; content: string }>,
		meta?: Partial<Pick<SessionInfo, "model" | "provider" | "branch">>,
	): void {
		const file = this.readFile(id);
		if (!file) return;
		file.messages = messages;
		file.messageCount = messages.length;
		file.lastActiveAt = new Date().toISOString();
		if (meta?.model) file.model = meta.model;
		if (meta?.provider) file.provider = meta.provider;
		if (meta?.branch) file.branch = meta.branch;
		this.write(id, file);
	}

	// -- Private helpers --

	private filePath(id: string): string {
		return path.join(this.dir, `${id}.json`);
	}

	private write(id: string, data: SessionFile): void {
		fs.writeFileSync(this.filePath(id), JSON.stringify(data, null, 2));
	}

	private readFile(id: string): SessionFile | null {
		try {
			const raw = fs.readFileSync(this.filePath(id), "utf-8");
			return JSON.parse(raw) as SessionFile;
		} catch {
			return null;
		}
	}

	private listAll(): SessionInfo[] {
		try {
			const files = fs.readdirSync(this.dir).filter((f) => f.endsWith(".json"));
			const sessions: SessionInfo[] = [];
			for (const f of files) {
				try {
					const raw = fs.readFileSync(path.join(this.dir, f), "utf-8");
					const parsed = JSON.parse(raw) as SessionFile;
					// Return info without messages (lightweight)
					const { messages: _, ...info } = parsed;
					sessions.push(info);
				} catch {
					// Skip corrupt files
				}
			}
			return sessions;
		} catch {
			return [];
		}
	}
}
