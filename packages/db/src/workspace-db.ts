/**
 * Workspace-shared SQLite database.
 *
 * One `.8gent/state.db` per workspace, shared between the harness process and
 * any host processes (TUI, daemon, dashboard) via WAL mode. Survives restarts.
 *
 * Out of scope: multi-device sync (control-plane), replacing Convex for cloud
 * state, replacing the @8gent/memory store. This is workspace-local glue.
 */

import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { applyMigrations, currentSchemaVersion, targetSchemaVersion } from "./migrations.js";

// ── Types ─────────────────────────────────────────────────────────────

export type AgentSessionStatus = "active" | "idle" | "completed" | "failed" | "aborted";
export type AgentChannel = "os" | "app" | "telegram" | "discord" | "api";

export interface KvEntry {
	key: string;
	value: unknown;
	namespace: string;
	createdAt: number;
	updatedAt: number;
}

export interface AgentSessionRecord {
	id: string;
	parentId: string | null;
	agentName: string;
	channel: AgentChannel;
	status: AgentSessionStatus;
	model: string | null;
	provider: string | null;
	startedAt: number;
	endedAt: number | null;
	metadata: Record<string, unknown> | null;
	tokensIn: number;
	tokensOut: number;
}

export interface StartAgentSessionInput {
	id: string;
	agentName: string;
	parentId?: string;
	channel?: AgentChannel;
	model?: string;
	provider?: string;
	metadata?: Record<string, unknown>;
}

export interface UpdateAgentSessionInput {
	status?: AgentSessionStatus;
	model?: string;
	provider?: string;
	metadata?: Record<string, unknown>;
	tokensIn?: number;
	tokensOut?: number;
	endedAt?: number;
}

export interface AppStateEntry {
	appId: string;
	key: string;
	value: unknown;
	updatedAt: number;
}

export interface SkillStateEntry {
	skillId: string;
	key: string;
	value: unknown;
	lastExecutedAt: number | null;
	executionCount: number;
	updatedAt: number;
}

export interface MemoryIndexEntry {
	id: string;
	memoryId: string;
	scope: string;
	topic: string | null;
	importance: number;
	createdAt: number;
	updatedAt: number;
}

export interface UpsertMemoryIndexInput {
	id: string;
	memoryId: string;
	scope: string;
	topic?: string;
	importance?: number;
}

export interface WorkspaceDbOptions {
	/** Override the default `.8gent/state.db` path. */
	dbPath?: string;
	/** Skip running migrations on open (tests only). */
	skipMigrations?: boolean;
	/** Open as read-only. */
	readonly?: boolean;
}

// ── Path resolution ───────────────────────────────────────────────────

/**
 * Resolve the workspace state DB path for a given workspace root.
 * The `.8gent/` parent directory is created if it does not exist.
 */
export function resolveWorkspaceDbPath(workspaceRoot: string): string {
	const dotDir = path.join(workspaceRoot, ".8gent");
	if (!fs.existsSync(dotDir)) {
		fs.mkdirSync(dotDir, { recursive: true });
	}
	return path.join(dotDir, "state.db");
}

// ── Helpers ───────────────────────────────────────────────────────────

function jsonStringify(value: unknown): string {
	return JSON.stringify(value ?? null);
}

function jsonParse<T = unknown>(value: string | null | undefined): T | null {
	if (value == null) return null;
	try {
		return JSON.parse(value) as T;
	} catch {
		return null;
	}
}

interface AgentSessionRow {
	id: string;
	parent_id: string | null;
	agent_name: string;
	channel: string;
	status: string;
	model: string | null;
	provider: string | null;
	started_at: number;
	ended_at: number | null;
	metadata: string | null;
	tokens_in: number;
	tokens_out: number;
}

function rowToAgentSession(row: AgentSessionRow): AgentSessionRecord {
	return {
		id: row.id,
		parentId: row.parent_id,
		agentName: row.agent_name,
		channel: row.channel as AgentChannel,
		status: row.status as AgentSessionStatus,
		model: row.model,
		provider: row.provider,
		startedAt: row.started_at,
		endedAt: row.ended_at,
		metadata: jsonParse<Record<string, unknown>>(row.metadata),
		tokensIn: row.tokens_in,
		tokensOut: row.tokens_out,
	};
}

// ── WorkspaceDb ───────────────────────────────────────────────────────

export class WorkspaceDb {
	readonly db: Database;
	readonly path: string;
	private closed = false;

	constructor(workspaceRootOrOptions: string | WorkspaceDbOptions = {}) {
		const options: WorkspaceDbOptions =
			typeof workspaceRootOrOptions === "string"
				? { dbPath: resolveWorkspaceDbPath(workspaceRootOrOptions) }
				: workspaceRootOrOptions;

		this.path = options.dbPath ?? resolveWorkspaceDbPath(process.cwd());

		// Ensure parent dir exists for explicit dbPath overrides.
		const parentDir = path.dirname(this.path);
		if (!fs.existsSync(parentDir)) {
			fs.mkdirSync(parentDir, { recursive: true });
		}

		this.db = new Database(this.path, {
			create: !options.readonly,
			readonly: options.readonly ?? false,
		});

		if (!options.readonly) {
			this.configurePragmas();
			if (!options.skipMigrations) {
				applyMigrations(this.db);
			}
		}
	}

	private configurePragmas(): void {
		// WAL is the whole point: lets multiple processes read while one writes.
		try {
			this.db.exec("PRAGMA journal_mode = WAL");
			this.db.exec("PRAGMA synchronous = NORMAL");
			this.db.exec("PRAGMA busy_timeout = 5000");
			this.db.exec("PRAGMA foreign_keys = ON");
			this.db.exec("PRAGMA cache_size = -32000"); // 32MB
		} catch (err) {
			console.warn("[workspace-db] PRAGMA init warning:", (err as Error).message);
		}
	}

	/** Returns currently-applied schema version. */
	getSchemaVersion(): number {
		return currentSchemaVersion(this.db);
	}

	/** Returns target schema version (highest known migration). */
	getTargetSchemaVersion(): number {
		return targetSchemaVersion();
	}

	// ── kv_store ────────────────────────────────────────────────────────

	kvSet(key: string, value: unknown, namespace = "default"): void {
		const now = Date.now();
		this.db
			.prepare(
				`INSERT INTO kv_store (key, value, namespace, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(key) DO UPDATE SET
				   value = excluded.value,
				   namespace = excluded.namespace,
				   updated_at = excluded.updated_at`,
			)
			.run(key, jsonStringify(value), namespace, now, now);
	}

	kvGet<T = unknown>(key: string): T | null {
		const row = this.db
			.query<{ value: string }, [string]>(
				"SELECT value FROM kv_store WHERE key = ?",
			)
			.get(key);
		if (!row) return null;
		return jsonParse<T>(row.value);
	}

	kvGetEntry(key: string): KvEntry | null {
		interface Row {
			key: string;
			value: string;
			namespace: string;
			created_at: number;
			updated_at: number;
		}
		const row = this.db
			.query<Row, [string]>("SELECT * FROM kv_store WHERE key = ?")
			.get(key);
		if (!row) return null;
		return {
			key: row.key,
			value: jsonParse(row.value),
			namespace: row.namespace,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	}

	kvDelete(key: string): boolean {
		const result = this.db.prepare("DELETE FROM kv_store WHERE key = ?").run(key);
		return result.changes > 0;
	}

	kvList(namespace?: string): KvEntry[] {
		interface Row {
			key: string;
			value: string;
			namespace: string;
			created_at: number;
			updated_at: number;
		}
		const rows = namespace
			? this.db
					.query<Row, [string]>(
						"SELECT * FROM kv_store WHERE namespace = ? ORDER BY updated_at DESC",
					)
					.all(namespace)
			: this.db
					.query<Row, []>("SELECT * FROM kv_store ORDER BY updated_at DESC")
					.all();
		return rows.map((row) => ({
			key: row.key,
			value: jsonParse(row.value),
			namespace: row.namespace,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		}));
	}

	// ── agent_sessions ──────────────────────────────────────────────────

	startAgentSession(input: StartAgentSessionInput): AgentSessionRecord {
		const now = Date.now();
		this.db
			.prepare(
				`INSERT INTO agent_sessions
					(id, parent_id, agent_name, channel, status, model, provider,
					 started_at, ended_at, metadata, tokens_in, tokens_out)
				 VALUES (?, ?, ?, ?, 'active', ?, ?, ?, NULL, ?, 0, 0)`,
			)
			.run(
				input.id,
				input.parentId ?? null,
				input.agentName,
				input.channel ?? "os",
				input.model ?? null,
				input.provider ?? null,
				now,
				input.metadata ? jsonStringify(input.metadata) : null,
			);
		const session = this.getAgentSession(input.id);
		if (!session) throw new Error(`Failed to insert agent session: ${input.id}`);
		return session;
	}

	getAgentSession(id: string): AgentSessionRecord | null {
		const row = this.db
			.query<AgentSessionRow, [string]>("SELECT * FROM agent_sessions WHERE id = ?")
			.get(id);
		return row ? rowToAgentSession(row) : null;
	}

	updateAgentSession(id: string, patch: UpdateAgentSessionInput): AgentSessionRecord | null {
		const sets: string[] = [];
		const args: (string | number | null)[] = [];

		if (patch.status !== undefined) {
			sets.push("status = ?");
			args.push(patch.status);
		}
		if (patch.model !== undefined) {
			sets.push("model = ?");
			args.push(patch.model);
		}
		if (patch.provider !== undefined) {
			sets.push("provider = ?");
			args.push(patch.provider);
		}
		if (patch.metadata !== undefined) {
			sets.push("metadata = ?");
			args.push(jsonStringify(patch.metadata));
		}
		if (patch.tokensIn !== undefined) {
			sets.push("tokens_in = ?");
			args.push(patch.tokensIn);
		}
		if (patch.tokensOut !== undefined) {
			sets.push("tokens_out = ?");
			args.push(patch.tokensOut);
		}
		if (patch.endedAt !== undefined) {
			sets.push("ended_at = ?");
			args.push(patch.endedAt);
		}

		if (sets.length === 0) return this.getAgentSession(id);

		args.push(id);
		this.db
			.prepare(`UPDATE agent_sessions SET ${sets.join(", ")} WHERE id = ?`)
			.run(...args);

		return this.getAgentSession(id);
	}

	endAgentSession(id: string, status: AgentSessionStatus = "completed"): AgentSessionRecord | null {
		return this.updateAgentSession(id, { status, endedAt: Date.now() });
	}

	listAgentSessions(opts: { status?: AgentSessionStatus; limit?: number } = {}): AgentSessionRecord[] {
		const limit = opts.limit ?? 100;
		const rows = opts.status
			? this.db
					.query<AgentSessionRow, [string, number]>(
						"SELECT * FROM agent_sessions WHERE status = ? ORDER BY started_at DESC LIMIT ?",
					)
					.all(opts.status, limit)
			: this.db
					.query<AgentSessionRow, [number]>(
						"SELECT * FROM agent_sessions ORDER BY started_at DESC LIMIT ?",
					)
					.all(limit);
		return rows.map(rowToAgentSession);
	}

	// ── app_state ───────────────────────────────────────────────────────

	setAppState(appId: string, key: string, value: unknown): void {
		const now = Date.now();
		this.db
			.prepare(
				`INSERT INTO app_state (app_id, key, value, updated_at)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(app_id, key) DO UPDATE SET
				   value = excluded.value,
				   updated_at = excluded.updated_at`,
			)
			.run(appId, key, jsonStringify(value), now);
	}

	getAppState<T = unknown>(appId: string, key: string): T | null {
		const row = this.db
			.query<{ value: string }, [string, string]>(
				"SELECT value FROM app_state WHERE app_id = ? AND key = ?",
			)
			.get(appId, key);
		return row ? jsonParse<T>(row.value) : null;
	}

	listAppState(appId: string): AppStateEntry[] {
		interface Row {
			app_id: string;
			key: string;
			value: string;
			updated_at: number;
		}
		const rows = this.db
			.query<Row, [string]>(
				"SELECT * FROM app_state WHERE app_id = ? ORDER BY updated_at DESC",
			)
			.all(appId);
		return rows.map((row) => ({
			appId: row.app_id,
			key: row.key,
			value: jsonParse(row.value),
			updatedAt: row.updated_at,
		}));
	}

	deleteAppState(appId: string, key: string): boolean {
		const result = this.db
			.prepare("DELETE FROM app_state WHERE app_id = ? AND key = ?")
			.run(appId, key);
		return result.changes > 0;
	}

	// ── skill_state ─────────────────────────────────────────────────────

	setSkillState(skillId: string, key: string, value: unknown): void {
		const now = Date.now();
		this.db
			.prepare(
				`INSERT INTO skill_state (skill_id, key, value, last_executed_at, execution_count, updated_at)
				 VALUES (?, ?, ?, NULL, 0, ?)
				 ON CONFLICT(skill_id, key) DO UPDATE SET
				   value = excluded.value,
				   updated_at = excluded.updated_at`,
			)
			.run(skillId, key, jsonStringify(value), now);
	}

	getSkillState<T = unknown>(skillId: string, key: string): T | null {
		const row = this.db
			.query<{ value: string }, [string, string]>(
				"SELECT value FROM skill_state WHERE skill_id = ? AND key = ?",
			)
			.get(skillId, key);
		return row ? jsonParse<T>(row.value) : null;
	}

	recordSkillExecution(skillId: string, key: string): SkillStateEntry | null {
		const now = Date.now();
		this.db
			.prepare(
				`INSERT INTO skill_state (skill_id, key, value, last_executed_at, execution_count, updated_at)
				 VALUES (?, ?, 'null', ?, 1, ?)
				 ON CONFLICT(skill_id, key) DO UPDATE SET
				   last_executed_at = excluded.last_executed_at,
				   execution_count = skill_state.execution_count + 1,
				   updated_at = excluded.updated_at`,
			)
			.run(skillId, key, now, now);
		return this.getSkillStateEntry(skillId, key);
	}

	getSkillStateEntry(skillId: string, key: string): SkillStateEntry | null {
		interface Row {
			skill_id: string;
			key: string;
			value: string;
			last_executed_at: number | null;
			execution_count: number;
			updated_at: number;
		}
		const row = this.db
			.query<Row, [string, string]>(
				"SELECT * FROM skill_state WHERE skill_id = ? AND key = ?",
			)
			.get(skillId, key);
		if (!row) return null;
		return {
			skillId: row.skill_id,
			key: row.key,
			value: jsonParse(row.value),
			lastExecutedAt: row.last_executed_at,
			executionCount: row.execution_count,
			updatedAt: row.updated_at,
		};
	}

	// ── memory_index ────────────────────────────────────────────────────

	upsertMemoryIndex(input: UpsertMemoryIndexInput): MemoryIndexEntry {
		const now = Date.now();
		this.db
			.prepare(
				`INSERT INTO memory_index (id, memory_id, scope, topic, importance, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET
				   memory_id = excluded.memory_id,
				   scope = excluded.scope,
				   topic = excluded.topic,
				   importance = excluded.importance,
				   updated_at = excluded.updated_at`,
			)
			.run(
				input.id,
				input.memoryId,
				input.scope,
				input.topic ?? null,
				input.importance ?? 0.5,
				now,
				now,
			);
		const entry = this.getMemoryIndexEntry(input.id);
		if (!entry) throw new Error(`Failed to upsert memory_index: ${input.id}`);
		return entry;
	}

	getMemoryIndexEntry(id: string): MemoryIndexEntry | null {
		interface Row {
			id: string;
			memory_id: string;
			scope: string;
			topic: string | null;
			importance: number;
			created_at: number;
			updated_at: number;
		}
		const row = this.db
			.query<Row, [string]>("SELECT * FROM memory_index WHERE id = ?")
			.get(id);
		if (!row) return null;
		return {
			id: row.id,
			memoryId: row.memory_id,
			scope: row.scope,
			topic: row.topic,
			importance: row.importance,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	}

	listMemoryIndex(opts: { scope?: string; topic?: string; limit?: number } = {}): MemoryIndexEntry[] {
		interface Row {
			id: string;
			memory_id: string;
			scope: string;
			topic: string | null;
			importance: number;
			created_at: number;
			updated_at: number;
		}
		const limit = opts.limit ?? 100;
		const where: string[] = [];
		const args: (string | number)[] = [];
		if (opts.scope) {
			where.push("scope = ?");
			args.push(opts.scope);
		}
		if (opts.topic) {
			where.push("topic = ?");
			args.push(opts.topic);
		}
		const sql = `SELECT * FROM memory_index ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY importance DESC, updated_at DESC LIMIT ?`;
		args.push(limit);
		const rows = this.db.query<Row, (string | number)[]>(sql).all(...args);
		return rows.map((row) => ({
			id: row.id,
			memoryId: row.memory_id,
			scope: row.scope,
			topic: row.topic,
			importance: row.importance,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		}));
	}

	deleteMemoryIndex(id: string): boolean {
		const result = this.db.prepare("DELETE FROM memory_index WHERE id = ?").run(id);
		return result.changes > 0;
	}

	// ── lifecycle ───────────────────────────────────────────────────────

	/** Force a checkpoint: fold the WAL back into the main DB file. */
	checkpoint(): void {
		this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	}

	/** Run a function inside a transaction. */
	transaction<T>(fn: () => T): T {
		const tx = this.db.transaction(fn);
		return tx() as T;
	}

	close(): void {
		if (this.closed) return;
		try {
			this.checkpoint();
		} catch {
			// best effort
		}
		this.db.close();
		this.closed = true;
	}

	get isClosed(): boolean {
		return this.closed;
	}
}

// ── Singleton helpers ────────────────────────────────────────────────

let _shared: WorkspaceDb | null = null;

/**
 * Get (or open) the shared workspace DB for the current process.
 * Defaults to `process.cwd()/.8gent/state.db`.
 */
export function getWorkspaceDb(workspaceRoot?: string): WorkspaceDb {
	if (_shared && !_shared.isClosed) return _shared;
	_shared = new WorkspaceDb(workspaceRoot ?? process.cwd());
	return _shared;
}

/** Close the shared workspace DB (call on process exit). */
export function closeWorkspaceDb(): void {
	if (_shared && !_shared.isClosed) {
		_shared.close();
	}
	_shared = null;
}
