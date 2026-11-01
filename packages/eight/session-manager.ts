/**
 * SessionManager - named sessions for the TUI, the CLI and the daemon.
 *
 * Backed by the JSONL tree store (session-store.ts): one append-only file per
 * session in <sessions dir>/tree/<id>.jsonl. Saving a whole message list never
 * overwrites history: the shared prefix is kept and anything that changed goes
 * on a new branch (SessionStore.syncTranscript). Every save is first cut to
 * the chat a person sees (session-messages.ts chatMessages: user and assistant
 * text, no system lines, no harness notes), so different savers agree.
 *
 * Sessions written before the tree store existed (<sessions dir>/<id>.json)
 * are still listed and resumed. The first write to one copies it into the tree
 * store under the same id; the old file is left in place, untouched.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { chatMessages } from "./session-messages.js";
import {
	type SessionListItem,
	SessionStore,
	defaultSessionsDir,
	isSessionId,
	listSessions,
} from "./session-store.js";

export { SESSION_ID_PATTERN, defaultSessionsDir, isSessionId } from "./session-store.js";

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

type Msg = { role: string; content: string };
type SessionWithMessages = SessionInfo & { messages: Msg[] };

interface LegacyFile extends SessionInfo {
	messages: Msg[];
}

export class SessionManager {
	private dir: string;

	constructor(dataDir?: string) {
		this.dir = dataDir || defaultSessionsDir();
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
		const store = SessionStore.create(
			{
				id: randomUUID().slice(0, 8),
				name: opts?.name,
				model: opts?.model || "unknown",
				provider: opts?.provider || "ollama",
				cwd: opts?.cwd || process.cwd(),
				branch: opts?.branch,
			},
			this.dir,
		);
		return this.infoOf(store);
	}

	/** Resume a session by exact ID or name prefix match. Returns null if not found. */
	resume(nameOrId: string): SessionWithMessages | null {
		const needle = nameOrId.toLowerCase();
		const byId = this.get(needle);
		if (byId) return byId;
		const match = this.listAll().find(
			(s) => s.name?.toLowerCase().startsWith(needle) || s.id.startsWith(needle),
		);
		return match ? this.get(match.id) : null;
	}

	/** List sessions sorted by lastActiveAt descending. */
	list(limit = 20): SessionInfo[] {
		return this.listAll().slice(0, limit);
	}

	/** Read one session by exact id (no name matching). Null when absent or the id is not plain. */
	get(id: string): SessionWithMessages | null {
		if (!isSessionId(id)) return null;
		const store = SessionStore.open(id, this.dir);
		if (store) return { ...this.infoOf(store), messages: store.messages() as Msg[] };
		return this.readLegacy(id);
	}

	/** The tree-store handle for a session (fork, branch, compaction), migrating an old file first. */
	store(id: string): SessionStore | null {
		if (!isSessionId(id)) return null;
		return SessionStore.open(id, this.dir) ?? this.migrate(id);
	}

	/**
	 * Write a session's messages, creating the session when it does not exist
	 * yet (a daemon session the store has never seen). Keeps the name and
	 * createdAt of an existing session.
	 */
	save(
		id: string,
		messages: Msg[],
		meta: Partial<Pick<SessionInfo, "model" | "provider" | "branch" | "cwd" | "channel">> = {},
	): void {
		if (!isSessionId(id)) throw new Error(`invalid session id: ${id}`);
		const store =
			this.store(id) ??
			SessionStore.create(
				{
					id,
					cwd: meta.cwd || process.cwd(),
					model: meta.model,
					provider: meta.provider,
					branch: meta.branch,
					channel: meta.channel,
				},
				this.dir,
			);
		this.write(store, messages, meta);
	}

	/** Rename a session. */
	rename(id: string, name: string): void {
		this.store(id)?.rename(name);
	}

	/** Get the most recently active session. */
	getLast(): SessionInfo | null {
		return this.list(1)[0] || null;
	}

	/** Update session with new messages and touch lastActiveAt. No-op for an unknown id. */
	update(
		id: string,
		messages: Msg[],
		meta?: Partial<Pick<SessionInfo, "model" | "provider" | "branch">>,
	): void {
		const store = this.store(id);
		if (store) this.write(store, messages, meta ?? {});
	}

	// -- Private helpers --

	private write(
		store: SessionStore,
		messages: Msg[],
		meta: Partial<Pick<SessionInfo, "model" | "provider" | "branch" | "channel">>,
	): void {
		// One shape for every saver (TUI autosave keeps system lines, /share and
		// the daemon do not): without this each alternation would branch.
		store.syncTranscript(chatMessages(messages));
		const changed: Partial<Pick<SessionInfo, "model" | "provider" | "branch" | "channel">> = {};
		if (meta.channel && meta.channel !== store.channel) changed.channel = meta.channel;
		if (meta.model && meta.model !== store.model) changed.model = meta.model;
		if (meta.provider && meta.provider !== store.provider) changed.provider = meta.provider;
		if (meta.branch && meta.branch !== (store.branchName ?? store.header.branch)) {
			changed.branch = meta.branch;
		}
		store.setInfo(changed);
		// lastActiveAt is the file's mtime: touch it even when nothing new was appended.
		const now = new Date();
		fs.utimesSync(store.file, now, now);
	}

	private infoOf(store: SessionStore): SessionInfo {
		const h = store.header;
		let lastActiveAt = h.createdAt;
		try {
			lastActiveAt = fs.statSync(store.file).mtime.toISOString();
		} catch {
			// just created
		}
		return {
			id: store.id,
			...(store.name !== undefined ? { name: store.name } : {}),
			model: store.model || "unknown",
			provider: store.provider || "unknown",
			cwd: h.cwd,
			...((store.branchName ?? h.branch) ? { branch: store.branchName ?? h.branch } : {}),
			messageCount: store.messages().length,
			createdAt: h.createdAt,
			lastActiveAt,
			...(store.channel ? { channel: store.channel } : {}),
		};
	}

	private listAll(): SessionInfo[] {
		return listSessions({ sessionsDir: this.dir, includeEmpty: true }).map(toInfo);
	}

	private legacyPath(id: string): string {
		return path.join(this.dir, `${id}.json`);
	}

	private readLegacy(id: string): SessionWithMessages | null {
		try {
			const file = JSON.parse(fs.readFileSync(this.legacyPath(id), "utf-8")) as LegacyFile;
			return file.id === id ? file : null;
		} catch {
			return null;
		}
	}

	/** Copy an old .json session into the tree store under the same id. The old file stays. */
	private migrate(id: string): SessionStore | null {
		const old = this.readLegacy(id);
		if (!old) return null;
		const store = SessionStore.create(
			{
				id,
				name: old.name,
				cwd: old.cwd || process.cwd(),
				model: old.model,
				provider: old.provider,
				branch: old.branch,
				channel: old.channel,
				createdAt: old.createdAt,
			},
			this.dir,
		);
		for (const m of chatMessages(old.messages ?? [])) store.append(m);
		return store;
	}
}

function toInfo(s: SessionListItem): SessionInfo {
	return {
		id: s.id,
		...(s.name !== undefined ? { name: s.name } : {}),
		model: s.model || "unknown",
		provider: s.provider || "unknown",
		cwd: s.cwd,
		...(s.branch ? { branch: s.branch } : {}),
		messageCount: s.messageCount,
		createdAt: s.createdAt,
		lastActiveAt: s.lastActiveAt,
		...(s.channel ? { channel: s.channel } : {}),
	};
}
