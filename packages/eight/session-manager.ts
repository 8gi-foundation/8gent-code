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
}

interface SessionFile extends SessionInfo {
	messages: Array<{ role: string; content: string }>;
}

/** Session ids are file names inside the sessions directory, never paths. */
const SESSION_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export class SessionManager {
	private dir: string;

	constructor(dataDir?: string) {
		this.dir = dataDir || path.join(process.env.HOME || "~", ".8gent", "sessions");
		fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
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
		const byId = this.readFile(needle);
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
		if (!SESSION_ID.test(id)) return;
		const { file: existing, corrupt } = this.load(id);
		// A file quarantined now, or earlier by list()/resume()/rename(), is
		// rebuilt from the caller's full message list so saves resume; name and
		// createdAt from the torn file are lost.
		if (!existing && !corrupt && !fs.existsSync(`${this.filePath(id)}.corrupt`)) return;
		const now = new Date().toISOString();
		const file: SessionFile = existing ?? {
			id,
			model: "unknown",
			provider: "ollama",
			cwd: process.cwd(),
			messageCount: 0,
			createdAt: now,
			lastActiveAt: now,
			messages: [],
		};
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

	/**
	 * Atomic save: write a temp file in the same directory, fsync it, then
	 * rename over the target. A crash or failed write leaves the previous
	 * file intact (same shape as turn-journal.ts write()).
	 */
	private write(id: string, data: SessionFile): void {
		if (!SESSION_ID.test(id)) throw new Error(`invalid session id: ${JSON.stringify(id)}`);
		const finalPath = this.filePath(id);
		const tmpPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
		const fd = fs.openSync(tmpPath, "wx", 0o600);
		let closed = false;
		try {
			fs.writeFileSync(fd, JSON.stringify(data, null, 2));
			fs.fsyncSync(fd);
			closed = true;
			fs.closeSync(fd);
			fs.renameSync(tmpPath, finalPath);
		} catch (err) {
			if (!closed) {
				try {
					fs.closeSync(fd);
				} catch {
					// Already failing; the original error is the one to report.
				}
			}
			fs.rmSync(tmpPath, { force: true });
			throw err;
		}
	}

	private readFile(id: string): SessionFile | null {
		return this.load(id).file;
	}

	/** Read a session file; one that fails to parse is moved aside, not skipped. */
	private load(id: string): { file: SessionFile | null; corrupt: boolean } {
		if (!SESSION_ID.test(id)) return { file: null, corrupt: false };
		const p = this.filePath(id);
		let raw: string;
		try {
			raw = fs.readFileSync(p, "utf-8");
		} catch {
			return { file: null, corrupt: false };
		}
		try {
			return { file: JSON.parse(raw) as SessionFile, corrupt: false };
		} catch {
			this.quarantine(p);
			return { file: null, corrupt: true };
		}
	}

	private quarantine(p: string): void {
		try {
			fs.renameSync(p, `${p}.corrupt`);
			console.warn(
				`[sessions] unreadable session file moved to ${p}.corrupt; saving continues, but the session name was reset`,
			);
		} catch {
			// Already moved by another reader; nothing to report twice.
		}
	}

	private listAll(): SessionInfo[] {
		try {
			const files = fs.readdirSync(this.dir).filter((f) => f.endsWith(".json"));
			const sessions: SessionInfo[] = [];
			for (const f of files) {
				const parsed = this.load(f.slice(0, -".json".length)).file;
				if (!parsed) continue;
				// Return info without messages (lightweight)
				const { messages: _, ...info } = parsed;
				sessions.push(info);
			}
			return sessions;
		} catch {
			return [];
		}
	}
}
