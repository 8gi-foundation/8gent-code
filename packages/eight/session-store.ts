/**
 * Session store: one append-only JSONL file per session, holding a tree.
 *
 * Line 1 is the header ({ type: "session", id, cwd, ... }). Every later line
 * is either a tree entry (has `id` + `parentId`) or a meta line (name change,
 * leaf move). Nothing is ever rewritten in place: branching moves the leaf,
 * forking copies a path into a new file. The current conversation is the path
 * from the root to the leaf.
 *
 * Files live in <sessions dir>/tree/<id>.jsonl, next to (not mixed with) the
 * agent's event logs (<id>.jsonl) and the older SessionManager files
 * (<id>.json). listSessions() reads both this store and those older files, so
 * a session started before this store existed can still be found and resumed.
 *
 * Public API used by other lanes:
 *   latestSessionForCwd(cwd)   newest session started in this folder (--continue)
 *   listSessions({ cwd })      every session, newest first (the picker)
 *   SessionStore.branch(id)    move the leaf: the next message continues from there
 *   SessionStore.fork(id)      copy root..id into a new session file
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { defaultSessionsDir, isSessionId } from "./session-manager.js";

export const SESSION_FORMAT_VERSION = 1;

export interface StoredMessage {
	role: string;
	/** A string, or provider content parts. Stored as given. */
	content: unknown;
}

export interface SessionHeader {
	type: "session";
	version: number;
	id: string;
	cwd: string;
	createdAt: string;
	model?: string;
	provider?: string;
	branch?: string;
	channel?: string;
	/** Set when this session was forked from another one. */
	parentSession?: { id: string; entryId: string | null };
}

export interface MessageEntry {
	type: "message";
	id: string;
	parentId: string | null;
	ts: string;
	message: StoredMessage;
}

/** Written when the user leaves a branch, so the abandoned work is not lost from view. */
export interface BranchSummaryEntry {
	type: "branch_summary";
	id: string;
	parentId: string | null;
	ts: string;
	/** The leaf that was left. */
	fromId: string | null;
	summary: string;
}

export type TreeEntry = MessageEntry | BranchSummaryEntry;

export interface InfoLine {
	type: "session_info";
	ts: string;
	name?: string;
	model?: string;
	provider?: string;
	branch?: string;
}

export interface LeafLine {
	type: "leaf";
	ts: string;
	/** null = before the first entry (a fresh root branch). */
	target: string | null;
}

export type MetaLine = InfoLine | LeafLine;
export type SessionLine = SessionHeader | TreeEntry | MetaLine;

export interface SessionListItem {
	id: string;
	name?: string;
	cwd: string;
	model?: string;
	provider?: string;
	createdAt: string;
	lastActiveAt: string;
	messageCount: number;
	/** "tree" = this store; "legacy" = an older SessionManager .json file. */
	format: "tree" | "legacy";
	file: string;
	parentSession?: { id: string; entryId: string | null };
}

export interface TreeNode {
	entry: TreeEntry;
	children: TreeNode[];
}

// ---------------------------------------------------------------------------
// Paths and ids
// ---------------------------------------------------------------------------

export function treeDir(sessionsDir: string = defaultSessionsDir()): string {
	return path.join(sessionsDir, "tree");
}

function newId(bytes: number): string {
	return randomBytes(bytes).toString("hex");
}

/** Folder key for cwd matching: resolved, and case-folded on Windows only. */
export function normalizeCwd(cwd: string): string {
	const resolved = path.resolve(cwd);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function writeOwnerOnly(file: string, text: string, flag: "wx" | "a"): void {
	// Owner-only: transcripts carry whatever was said and pasted (#3929).
	fs.writeFileSync(file, text, { mode: 0o600, flag });
}

function parseLines(text: string, file: string): SessionLine[] {
	const out: SessionLine[] = [];
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line) continue;
		try {
			out.push(JSON.parse(line) as SessionLine);
		} catch {
			// A torn last line (crash mid-write) is skipped; anything earlier is corruption.
			if (i < lines.length - 2) throw new Error(`corrupt session line ${i + 1} in ${file}`);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// SessionStore: one session file
// ---------------------------------------------------------------------------

export class SessionStore {
	readonly file: string;
	readonly sessionsDir: string;
	private _header: SessionHeader;
	private entries = new Map<string, TreeEntry>();
	private order: string[] = [];
	private info: Omit<InfoLine, "type" | "ts"> = {};
	private _leafId: string | null = null;
	/**
	 * Byte length of the file up to its last newline when it was opened with a
	 * torn last line (a crash mid-write). The first write cuts the file back to
	 * this length so the new line does not get glued onto the fragment.
	 */
	private tornAt: number | null = null;

	private constructor(sessionsDir: string, header: SessionHeader) {
		this.sessionsDir = sessionsDir;
		this._header = header;
		this.file = path.join(treeDir(sessionsDir), `${header.id}.jsonl`);
	}

	/** Start a new session file. */
	static create(
		opts: {
			cwd?: string;
			id?: string;
			name?: string;
			model?: string;
			provider?: string;
			branch?: string;
			channel?: string;
			parentSession?: SessionHeader["parentSession"];
		} = {},
		sessionsDir: string = defaultSessionsDir(),
	): SessionStore {
		const id = opts.id ?? newId(4);
		if (!isSessionId(id)) throw new Error(`invalid session id: ${id}`);
		const dir = treeDir(sessionsDir);
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const header: SessionHeader = {
			type: "session",
			version: SESSION_FORMAT_VERSION,
			id,
			cwd: path.resolve(opts.cwd ?? process.cwd()),
			createdAt: new Date().toISOString(),
			...(opts.model ? { model: opts.model } : {}),
			...(opts.provider ? { provider: opts.provider } : {}),
			...(opts.branch ? { branch: opts.branch } : {}),
			...(opts.channel ? { channel: opts.channel } : {}),
			...(opts.parentSession ? { parentSession: opts.parentSession } : {}),
		};
		const store = new SessionStore(sessionsDir, header);
		try {
			// "wx": fails if anything (a file, a planted symlink) is already there.
			writeOwnerOnly(store.file, `${JSON.stringify(header)}\n`, "wx");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			// Same id created by someone else first (two writers migrating one
			// session): that session is the one to use. A random id collision
			// gets a fresh id instead of joining a stranger's session.
			if (opts.id === undefined) return SessionStore.create({ ...opts }, sessionsDir);
			const existing = SessionStore.open(id, sessionsDir);
			if (!existing) throw err;
			return existing;
		}
		if (opts.name) store.rename(opts.name);
		return store;
	}

	/** Open an existing session by id. Null when it is not in this store. */
	static open(id: string, sessionsDir: string = defaultSessionsDir()): SessionStore | null {
		if (!isSessionId(id)) return null;
		const file = path.join(treeDir(sessionsDir), `${id}.jsonl`);
		let text: string;
		try {
			text = fs.readFileSync(file, "utf-8");
		} catch {
			return null;
		}
		const lines = parseLines(text, file);
		const header = lines[0];
		if (!header || header.type !== "session") throw new Error(`missing session header in ${file}`);
		const store = new SessionStore(sessionsDir, header);
		for (const line of lines.slice(1)) store.apply(line);
		if (!text.endsWith("\n")) {
			const cut = text.lastIndexOf("\n") + 1;
			store.tornAt = Buffer.byteLength(text.slice(0, cut));
		}
		return store;
	}

	static exists(id: string, sessionsDir: string = defaultSessionsDir()): boolean {
		return isSessionId(id) && fs.existsSync(path.join(treeDir(sessionsDir), `${id}.jsonl`));
	}

	get id(): string {
		return this._header.id;
	}
	get header(): SessionHeader {
		return this._header;
	}
	get name(): string | undefined {
		return this.info.name;
	}
	get model(): string | undefined {
		return this.info.model ?? this._header.model;
	}
	get provider(): string | undefined {
		return this.info.provider ?? this._header.provider;
	}
	/** The entry the next append continues from. */
	get leafId(): string | null {
		return this._leafId;
	}

	getEntry(id: string): TreeEntry | undefined {
		return this.entries.get(id);
	}

	/** Every tree entry in file order. */
	allEntries(): TreeEntry[] {
		return this.order.map((id) => this.entries.get(id) as TreeEntry);
	}

	/** Append a message under the leaf and make it the new leaf. Returns its id. */
	append(message: StoredMessage): string {
		const entry: MessageEntry = {
			type: "message",
			id: this.freshEntryId(),
			parentId: this._leafId,
			ts: new Date().toISOString(),
			message: { role: message.role, content: message.content },
		};
		this.write(entry);
		return entry.id;
	}

	/**
	 * Continue from an earlier entry in this same file (Pi's /tree jump).
	 * Nothing is deleted: the old branch stays in the tree. When a summary is
	 * given it is recorded as a branch_summary entry under the target, so the
	 * new branch's context says what the abandoned one did.
	 */
	branch(entryId: string | null, opts: { summary?: string } = {}): void {
		if (entryId !== null && !this.entries.has(entryId))
			throw new Error(`entry ${entryId} not found`);
		const fromId = this._leafId;
		this.write({ type: "leaf", ts: new Date().toISOString(), target: entryId });
		if (opts.summary) {
			this.write({
				type: "branch_summary",
				id: this.freshEntryId(),
				parentId: entryId,
				ts: new Date().toISOString(),
				fromId,
				summary: opts.summary,
			});
		}
	}

	/**
	 * Copy the path root..entryId (default: the leaf) into a new session file.
	 * Entry ids are kept, so the fork can be traced back to its source.
	 */
	fork(
		entryId: string | null = this._leafId,
		opts: { name?: string; cwd?: string } = {},
	): SessionStore {
		if (entryId !== null && !this.entries.has(entryId))
			throw new Error(`entry ${entryId} not found`);
		const child = SessionStore.create(
			{
				cwd: opts.cwd ?? this._header.cwd,
				name: opts.name,
				model: this.model,
				provider: this.provider,
				branch: this._header.branch,
				channel: this._header.channel,
				parentSession: { id: this.id, entryId },
			},
			this.sessionsDir,
		);
		for (const entry of this.pathTo(entryId)) child.write(entry);
		return child;
	}

	/** Set the display name (and optionally model/provider) without touching the tree. */
	rename(name: string): void {
		this.write({ type: "session_info", ts: new Date().toISOString(), name });
	}

	setInfo(info: Omit<InfoLine, "type" | "ts">): void {
		const clean = Object.fromEntries(Object.entries(info).filter(([, v]) => v !== undefined));
		if (Object.keys(clean).length === 0) return;
		this.write({ type: "session_info", ts: new Date().toISOString(), ...clean });
	}

	/** Entries from the root to entryId (default: the leaf), oldest first. */
	pathTo(entryId: string | null = this._leafId): TreeEntry[] {
		const out: TreeEntry[] = [];
		let cur = entryId;
		const seen = new Set<string>();
		while (cur) {
			if (seen.has(cur)) throw new Error(`cycle at entry ${cur} in ${this.file}`);
			seen.add(cur);
			const entry = this.entries.get(cur);
			if (!entry) break;
			out.push(entry);
			cur = entry.parentId;
		}
		return out.reverse();
	}

	/** The messages on the current path, oldest first (branch summaries become notes). */
	messages(entryId: string | null = this._leafId): StoredMessage[] {
		return this.pathTo(entryId).map(toMessage);
	}

	/** The whole tree, for a /tree view. Roots in file order, children in file order. */
	tree(): TreeNode[] {
		const nodes = new Map<string, TreeNode>();
		for (const id of this.order)
			nodes.set(id, { entry: this.entries.get(id) as TreeEntry, children: [] });
		const roots: TreeNode[] = [];
		for (const id of this.order) {
			const node = nodes.get(id) as TreeNode;
			const parent = node.entry.parentId ? nodes.get(node.entry.parentId) : undefined;
			if (parent) parent.children.push(node);
			else roots.push(node);
		}
		return roots;
	}

	/** Leaves of the tree (entries with no children): one per branch. */
	leaves(): TreeEntry[] {
		const hasChild = new Set<string>();
		for (const e of this.entries.values()) if (e.parentId) hasChild.add(e.parentId);
		return this.allEntries().filter((e) => !hasChild.has(e.id));
	}

	// -- internals --

	private freshEntryId(): string {
		let id = newId(4);
		while (this.entries.has(id)) id = newId(4);
		return id;
	}

	private write(line: TreeEntry | MetaLine): void {
		if (this.tornAt !== null) {
			fs.truncateSync(this.file, this.tornAt);
			this.tornAt = null;
		}
		writeOwnerOnly(this.file, `${JSON.stringify(line)}\n`, "a");
		this.apply(line);
	}

	private apply(line: SessionLine): void {
		switch (line.type) {
			case "message":
			case "branch_summary":
				if (!this.entries.has(line.id)) this.order.push(line.id);
				this.entries.set(line.id, line);
				this._leafId = line.id;
				break;
			case "leaf":
				this._leafId = line.target;
				break;
			case "session_info": {
				// Field by field: a "__proto__" key in the file must not reach any prototype.
				if (typeof line.name === "string") this.info.name = line.name;
				if (typeof line.model === "string") this.info.model = line.model;
				if (typeof line.provider === "string") this.info.provider = line.provider;
				if (typeof line.branch === "string") this.info.branch = line.branch;
				break;
			}
			default:
				// Unknown line types from a newer version are kept on disk and ignored here.
				break;
		}
	}
}

function toMessage(entry: TreeEntry): StoredMessage {
	if (entry.type === "branch_summary") {
		return {
			role: "user",
			content: `[Branch summary: work on an earlier branch]\n\n${entry.summary}`,
		};
	}
	return entry.message;
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

function listTree(sessionsDir: string): SessionListItem[] {
	const dir = treeDir(sessionsDir);
	let files: string[];
	try {
		files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
	} catch {
		return [];
	}
	const out: SessionListItem[] = [];
	for (const f of files) {
		const file = path.join(dir, f);
		try {
			const text = fs.readFileSync(file, "utf-8");
			const nl = text.indexOf("\n");
			const header = JSON.parse(nl === -1 ? text : text.slice(0, nl)) as SessionHeader;
			if (header.type !== "session" || !isSessionId(header.id)) continue;
			let name: string | undefined;
			let model = header.model;
			let provider = header.provider;
			// Only info lines need parsing; messages are counted by type tag.
			for (const line of text.split("\n")) {
				if (!line.includes('"type":"session_info"')) continue;
				try {
					const info = JSON.parse(line) as InfoLine;
					if (info.name !== undefined) name = info.name;
					if (info.model !== undefined) model = info.model;
					if (info.provider !== undefined) provider = info.provider;
				} catch {
					// torn line
				}
			}
			const messageCount = text.split('{"type":"message"').length - 1;
			out.push({
				id: header.id,
				name,
				cwd: header.cwd,
				model,
				provider,
				createdAt: header.createdAt,
				lastActiveAt: fs.statSync(file).mtime.toISOString(),
				messageCount,
				format: "tree",
				file,
				...(header.parentSession ? { parentSession: header.parentSession } : {}),
			});
		} catch {
			// Skip unreadable files; one bad file must not hide the rest.
		}
	}
	return out;
}

function listLegacy(sessionsDir: string): SessionListItem[] {
	let files: string[];
	try {
		files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".json"));
	} catch {
		return [];
	}
	const out: SessionListItem[] = [];
	for (const f of files) {
		const file = path.join(sessionsDir, f);
		try {
			const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
			const id = raw.id;
			if (!isSessionId(id) || typeof raw.cwd !== "string") continue;
			out.push({
				id,
				name: typeof raw.name === "string" ? raw.name : undefined,
				cwd: raw.cwd,
				model: typeof raw.model === "string" ? raw.model : undefined,
				provider: typeof raw.provider === "string" ? raw.provider : undefined,
				createdAt: String(raw.createdAt ?? ""),
				lastActiveAt: String(raw.lastActiveAt ?? raw.createdAt ?? ""),
				messageCount: typeof raw.messageCount === "number" ? raw.messageCount : 0,
				format: "legacy",
				file,
			});
		} catch {
			// corrupt legacy file
		}
	}
	return out;
}

/**
 * Every session, newest activity first. With `cwd`, only sessions started in
 * that folder. A session present in both stores is listed once, from the tree.
 */
export function listSessions(
	opts: { cwd?: string; limit?: number; sessionsDir?: string; includeEmpty?: boolean } = {},
): SessionListItem[] {
	const dir = opts.sessionsDir ?? defaultSessionsDir();
	const tree = listTree(dir);
	const treeIds = new Set(tree.map((s) => s.id));
	let all = [...tree, ...listLegacy(dir).filter((s) => !treeIds.has(s.id))];
	if (opts.cwd !== undefined) {
		const want = normalizeCwd(opts.cwd);
		all = all.filter((s) => normalizeCwd(s.cwd) === want);
	}
	if (!opts.includeEmpty) all = all.filter((s) => s.messageCount > 0);
	all.sort(
		(a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt) || b.id.localeCompare(a.id),
	);
	return opts.limit !== undefined ? all.slice(0, opts.limit) : all;
}

/**
 * The newest session with at least one message that was started in `cwd`.
 * This is what `--continue` resumes. Null when the folder has none.
 */
export function latestSessionForCwd(cwd: string, sessionsDir?: string): SessionListItem | null {
	return listSessions({ cwd, sessionsDir, limit: 1 })[0] ?? null;
}
