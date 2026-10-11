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

export const SESSION_FORMAT_VERSION = 1;

/** Ids become file names: only plain ids are ever read or written by id. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isSessionId(v: unknown): v is string {
	return typeof v === "string" && SESSION_ID_PATTERN.test(v);
}

/**
 * Where sessions live: $EIGHT_DATA_DIR/sessions when set, else
 * ~/.8gent/sessions. The TUI and the daemon both use this, so a session
 * shared through the daemon is the same file the TUI resumes (#3929).
 */
export function defaultSessionsDir(): string {
	const dataDir = process.env.EIGHT_DATA_DIR;
	return dataDir
		? path.join(dataDir, "sessions")
		: path.join(process.env.HOME || "~", ".8gent", "sessions");
}

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

/**
 * A compaction. It replaces nothing: the summarised messages stay in the file
 * as its ancestors. The model context starts from this summary plus the
 * entries from firstKeptId onward; undoing it (an "uncompact" line) makes the
 * context the full transcript again.
 */
export interface CompactionEntry {
	type: "compaction";
	id: string;
	parentId: string | null;
	ts: string;
	summary: string;
	/** First path entry kept verbatim after the summary; null = none kept. */
	firstKeptId: string | null;
	tokensBefore?: number;
	tokensAfter?: number;
}

export type TreeEntry = MessageEntry | BranchSummaryEntry | CompactionEntry;

export interface UncompactLine {
	type: "uncompact";
	ts: string;
	target: string;
}

export interface InfoLine {
	type: "session_info";
	ts: string;
	name?: string;
	model?: string;
	provider?: string;
	branch?: string;
	channel?: string;
}

export interface LeafLine {
	type: "leaf";
	ts: string;
	/** null = before the first entry (a fresh root branch). */
	target: string | null;
}

export type MetaLine = InfoLine | LeafLine | UncompactLine;
export type SessionLine = SessionHeader | TreeEntry | MetaLine;

export interface SessionListItem {
	id: string;
	name?: string;
	cwd: string;
	model?: string;
	provider?: string;
	createdAt: string;
	lastActiveAt: string;
	/** Message entries in the file, across every branch. */
	messageCount: number;
	branch?: string;
	channel?: string;
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

function writeOwnerOnly(file: string, text: string, flag: "w" | "a"): void {
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
	private undone = new Set<string>();

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
			/** Keep the original creation time (migration, import). */
			createdAt?: string;
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
			createdAt: opts.createdAt ?? new Date().toISOString(),
			...(opts.model ? { model: opts.model } : {}),
			...(opts.provider ? { provider: opts.provider } : {}),
			...(opts.branch ? { branch: opts.branch } : {}),
			...(opts.channel ? { channel: opts.channel } : {}),
			...(opts.parentSession ? { parentSession: opts.parentSession } : {}),
		};
		const store = new SessionStore(sessionsDir, header);
		if (fs.existsSync(store.file)) throw new Error(`session ${id} already exists`);
		writeOwnerOnly(store.file, `${JSON.stringify(header)}\n`, "w");
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
	/** The surface that owns the session when shared through the daemon. */
	get channel(): string | undefined {
		return this.info.channel ?? this._header.channel;
	}
	/** The git branch last recorded for this session. */
	get branchName(): string | undefined {
		return this.info.branch ?? this._header.branch;
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
		for (const entry of this.pathTo(entryId)) {
			child.write(entry);
			if (entry.type === "compaction" && this.undone.has(entry.id)) {
				child.write({ type: "uncompact", ts: new Date().toISOString(), target: entry.id });
			}
		}
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

	/**
	 * The full transcript on the current path, oldest first. Compactions are
	 * left out (nothing was removed); branch summaries appear as notes. This is
	 * what a person scrolls back through.
	 */
	messages(entryId: string | null = this._leafId): StoredMessage[] {
		return this.transcriptEntries(entryId).map(toMessage);
	}

	/** The path entries messages() renders, in the same order. */
	transcriptEntries(
		entryId: string | null = this._leafId,
	): Array<MessageEntry | BranchSummaryEntry> {
		return this.pathTo(entryId).filter(
			(e): e is MessageEntry | BranchSummaryEntry => e.type !== "compaction",
		);
	}

	/**
	 * What the model sees: the latest active compaction's summary, then the
	 * entries it kept, then everything after it. With no active compaction
	 * this equals messages().
	 */
	context(entryId: string | null = this._leafId): StoredMessage[] {
		const path = this.pathTo(entryId);
		let c = -1;
		for (let i = path.length - 1; i >= 0; i--) {
			const e = path[i];
			if (e.type === "compaction" && !this.undone.has(e.id)) {
				c = i;
				break;
			}
		}
		if (c === -1) return this.messages(entryId);
		const comp = path[c] as CompactionEntry;
		const keptFrom = comp.firstKeptId ? path.findIndex((e) => e.id === comp.firstKeptId) : c;
		const start = keptFrom === -1 || keptFrom > c ? c : keptFrom;
		const rest = [...path.slice(start, c), ...path.slice(c + 1)].filter(
			(e) => e.type !== "compaction",
		);
		return [toMessage(comp), ...rest.map(toMessage)];
	}

	/**
	 * Record a compaction at the leaf. Keeps the last `keepLast` transcript
	 * entries verbatim (or everything from `firstKeptId`). Originals stay in the
	 * file; undoCompaction() brings them back into context(). Returns the entry id.
	 */
	compact(
		summary: string,
		opts: {
			keepLast?: number;
			firstKeptId?: string | null;
			tokensBefore?: number;
			tokensAfter?: number;
		} = {},
	): string {
		const transcript = this.transcriptEntries();
		let firstKeptId: string | null = null;
		if (opts.firstKeptId !== undefined) {
			if (opts.firstKeptId !== null && !transcript.some((e) => e.id === opts.firstKeptId)) {
				throw new Error(`entry ${opts.firstKeptId} is not on the current path`);
			}
			firstKeptId = opts.firstKeptId;
		} else if (opts.keepLast && opts.keepLast > 0) {
			firstKeptId = transcript[Math.max(0, transcript.length - opts.keepLast)]?.id ?? null;
		}
		const entry: CompactionEntry = {
			type: "compaction",
			id: this.freshEntryId(),
			parentId: this._leafId,
			ts: new Date().toISOString(),
			summary,
			firstKeptId,
			...(opts.tokensBefore !== undefined ? { tokensBefore: opts.tokensBefore } : {}),
			...(opts.tokensAfter !== undefined ? { tokensAfter: opts.tokensAfter } : {}),
		};
		this.write(entry);
		return entry.id;
	}

	/** The compaction context() is applying right now, if any. */
	activeCompaction(entryId: string | null = this._leafId): CompactionEntry | null {
		const path = this.pathTo(entryId);
		for (let i = path.length - 1; i >= 0; i--) {
			const e = path[i];
			if (e.type === "compaction" && !this.undone.has(e.id)) return e;
		}
		return null;
	}

	/**
	 * Undo a compaction (default: the active one). The context goes back to the
	 * original messages; an older compaction on the path, if any, applies again.
	 * Returns the id undone, or null when there was nothing to undo.
	 */
	undoCompaction(compactionId?: string): string | null {
		const target = compactionId ?? this.activeCompaction()?.id;
		if (!target) return null;
		const entry = this.entries.get(target);
		if (!entry || entry.type !== "compaction")
			throw new Error(`entry ${target} is not a compaction`);
		if (this.undone.has(target)) return null;
		this.write({ type: "uncompact", ts: new Date().toISOString(), target });
		return target;
	}

	isUndone(compactionId: string): boolean {
		return this.undone.has(compactionId);
	}

	/**
	 * Make the current transcript equal `messages` without losing anything.
	 * The shared prefix is kept; when the list diverges from what is stored
	 * (an edit, a rewind, a rewrite), the leaf moves back to the last shared
	 * entry and the new tail is appended as a new branch. The old tail stays
	 * in the tree. This is how whole-list savers (the TUI, the daemon) write
	 * into the tree without ever destroying history.
	 */
	syncTranscript(messages: StoredMessage[]): { appended: number; branched: boolean } {
		const stored = this.transcriptEntries();
		const key = (m: StoredMessage) => `${m.role}\u0000${JSON.stringify(m.content)}`;
		let p = 0;
		while (
			p < stored.length &&
			p < messages.length &&
			key(toMessage(stored[p])) === key(messages[p])
		)
			p++;
		const branched = p < stored.length;
		if (branched) this.branch(p === 0 ? null : stored[p - 1].id);
		for (const m of messages.slice(p)) this.append(m);
		return { appended: messages.length - p, branched };
	}

	/** The session file as JSONL text (it already is the export format). */
	exportJSONL(): string {
		return fs.readFileSync(this.file, "utf-8");
	}

	/**
	 * Import a session exported by exportJSONL(). Every line is checked:
	 * parents must appear before children, ids must be plain, unknown line
	 * types are dropped. Keeps the original id when it is free, else assigns
	 * a new one. The imported session records where it came from.
	 */
	static importJSONL(
		text: string,
		opts: { sessionsDir?: string; cwd?: string; name?: string } = {},
	): SessionStore {
		const sessionsDir = opts.sessionsDir ?? defaultSessionsDir();
		const lines = parseLines(text, "import");
		const header = lines[0];
		if (!header || header.type !== "session" || typeof header.cwd !== "string") {
			throw new Error("import: first line must be a session header");
		}
		const seen = new Map<string, TreeEntry["type"]>();
		const out: Array<TreeEntry | MetaLine> = [];
		const isRef = (v: unknown) => v === null || (typeof v === "string" && seen.has(v));
		const str = (v: unknown) => v === undefined || typeof v === "string";
		for (const [i, raw] of lines.slice(1).entries()) {
			const line = raw as unknown as Record<string, unknown>;
			const bad = (why: string) => new Error(`import: line ${i + 2}: ${why}`);
			const ts = typeof line.ts === "string" ? line.ts : new Date().toISOString();
			switch (line.type) {
				case "message":
				case "branch_summary":
				case "compaction": {
					if (!isSessionId(line.id) || seen.has(line.id)) throw bad("bad or duplicate id");
					if (!isRef(line.parentId)) throw bad("parent must appear earlier");
					let entry: TreeEntry;
					if (line.type === "message") {
						const m = line.message as Record<string, unknown> | undefined;
						if (!m || typeof m.role !== "string") throw bad("message needs a role");
						entry = {
							type: "message",
							id: line.id,
							parentId: line.parentId as string | null,
							ts,
							message: { role: m.role, content: m.content },
						};
					} else if (line.type === "branch_summary") {
						if (typeof line.summary !== "string") throw bad("summary must be text");
						entry = {
							type: "branch_summary",
							id: line.id,
							parentId: line.parentId as string | null,
							ts,
							fromId: typeof line.fromId === "string" ? line.fromId : null,
							summary: line.summary,
						};
					} else {
						if (typeof line.summary !== "string") throw bad("summary must be text");
						if (!isRef(line.firstKeptId)) throw bad("firstKeptId must appear earlier");
						entry = {
							type: "compaction",
							id: line.id,
							parentId: line.parentId as string | null,
							ts,
							summary: line.summary,
							firstKeptId: line.firstKeptId as string | null,
							...(typeof line.tokensBefore === "number" ? { tokensBefore: line.tokensBefore } : {}),
							...(typeof line.tokensAfter === "number" ? { tokensAfter: line.tokensAfter } : {}),
						};
					}
					seen.set(entry.id, entry.type);
					out.push(entry);
					break;
				}
				case "leaf":
					if (!isRef(line.target)) throw bad("leaf target must appear earlier");
					out.push({ type: "leaf", ts, target: line.target as string | null });
					break;
				case "uncompact":
					if (typeof line.target !== "string" || seen.get(line.target) !== "compaction") {
						throw bad("uncompact must name an earlier compaction");
					}
					out.push({ type: "uncompact", ts, target: line.target });
					break;
				case "session_info":
					if (
						!str(line.name) ||
						!str(line.model) ||
						!str(line.provider) ||
						!str(line.branch) ||
						!str(line.channel)
					) {
						throw bad("session_info fields must be text");
					}
					out.push({
						type: "session_info",
						ts,
						...(line.name !== undefined ? { name: line.name as string } : {}),
						...(line.model !== undefined ? { model: line.model as string } : {}),
						...(line.provider !== undefined ? { provider: line.provider as string } : {}),
						...(line.branch !== undefined ? { branch: line.branch as string } : {}),
						...(line.channel !== undefined ? { channel: line.channel as string } : {}),
					});
					break;
				default:
					break;
			}
		}
		const keepId = isSessionId(header.id) && !SessionStore.exists(header.id, sessionsDir);
		const store = SessionStore.create(
			{
				id: keepId ? header.id : undefined,
				cwd: opts.cwd ?? header.cwd,
				model: typeof header.model === "string" ? header.model : undefined,
				provider: typeof header.provider === "string" ? header.provider : undefined,
				createdAt: typeof header.createdAt === "string" ? header.createdAt : undefined,
				parentSession:
					!keepId && isSessionId(header.id) ? { id: header.id, entryId: null } : undefined,
			},
			sessionsDir,
		);
		for (const line of out) store.write(line);
		if (opts.name) store.rename(opts.name);
		return store;
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
		writeOwnerOnly(this.file, `${JSON.stringify(line)}\n`, "a");
		this.apply(line);
	}

	private apply(line: SessionLine): void {
		switch (line.type) {
			case "message":
			case "branch_summary":
			case "compaction":
				if (!this.entries.has(line.id)) this.order.push(line.id);
				this.entries.set(line.id, line);
				this._leafId = line.id;
				break;
			case "leaf":
				this._leafId = line.target;
				break;
			case "uncompact":
				this.undone.add(line.target);
				break;
			case "session_info": {
				const { type: _t, ts: _ts, ...rest } = line;
				Object.assign(this.info, rest);
				break;
			}
			default:
				// Unknown line types from a newer version are kept on disk and ignored here.
				break;
		}
	}
}

export const COMPACTION_SUMMARY_PREFIX = "[Context Compaction Summary]";

function toMessage(entry: TreeEntry): StoredMessage {
	if (entry.type === "compaction") {
		return { role: "user", content: `${COMPACTION_SUMMARY_PREFIX}\n\n${entry.summary}` };
	}
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
			let branch = header.branch;
			let channel = header.channel;
			// Only info lines need parsing; messages are counted by type tag.
			for (const line of text.split("\n")) {
				if (!line.includes('"type":"session_info"')) continue;
				try {
					const info = JSON.parse(line) as InfoLine;
					if (info.name !== undefined) name = info.name;
					if (info.model !== undefined) model = info.model;
					if (info.provider !== undefined) provider = info.provider;
					if (info.branch !== undefined) branch = info.branch;
					if (info.channel !== undefined) channel = info.channel;
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
				...(branch ? { branch } : {}),
				...(channel ? { channel } : {}),
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
				...(typeof raw.branch === "string" ? { branch: raw.branch } : {}),
				...(typeof raw.channel === "string" ? { channel: raw.channel } : {}),
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
