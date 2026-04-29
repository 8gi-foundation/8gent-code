/**
 * Workspace DB migrations.
 *
 * Each migration is an idempotent SQL block paired with a monotonic version.
 * Applied versions are tracked in `schema_migrations`. New migrations are
 * appended to the array - never edit an existing migration in place once it
 * has shipped.
 */

import type { Database } from "bun:sqlite";

export interface Migration {
	version: number;
	name: string;
	up: string;
}

/**
 * Core schema. All tables created here are part of v1 of the workspace DB.
 *
 * Naming: snake_case tables, snake_case columns.
 * Timestamps: stored as INTEGER millis since epoch (Date.now()).
 */
const CORE_TABLES_SQL = `
-- Generic key/value store for ad-hoc workspace state.
CREATE TABLE IF NOT EXISTS kv_store (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL,
	namespace TEXT NOT NULL DEFAULT 'default',
	updated_at INTEGER NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kv_namespace ON kv_store(namespace);
CREATE INDEX IF NOT EXISTS idx_kv_updated_at ON kv_store(updated_at);

-- Agent session lifecycle records (start, end, status, metadata).
CREATE TABLE IF NOT EXISTS agent_sessions (
	id TEXT PRIMARY KEY,
	parent_id TEXT,
	agent_name TEXT NOT NULL,
	channel TEXT NOT NULL DEFAULT 'os',
	status TEXT NOT NULL DEFAULT 'active',
	model TEXT,
	provider TEXT,
	started_at INTEGER NOT NULL,
	ended_at INTEGER,
	metadata TEXT,
	tokens_in INTEGER NOT NULL DEFAULT 0,
	tokens_out INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_status ON agent_sessions(status);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_started ON agent_sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_parent ON agent_sessions(parent_id);

-- App-level state owned by a specific surface (tui, dashboard, daemon, etc.).
-- Distinct from kv_store: app_state is scoped per app + key, useful for things
-- like "last open tab" or "tui window size".
CREATE TABLE IF NOT EXISTS app_state (
	app_id TEXT NOT NULL,
	key TEXT NOT NULL,
	value TEXT NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (app_id, key)
);
CREATE INDEX IF NOT EXISTS idx_app_state_updated_at ON app_state(updated_at);

-- Skill state: persisted state for individual skills (cooldowns, learned
-- parameters, last execution, etc.).
CREATE TABLE IF NOT EXISTS skill_state (
	skill_id TEXT NOT NULL,
	key TEXT NOT NULL,
	value TEXT NOT NULL,
	last_executed_at INTEGER,
	execution_count INTEGER NOT NULL DEFAULT 0,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (skill_id, key)
);
CREATE INDEX IF NOT EXISTS idx_skill_state_executed ON skill_state(last_executed_at DESC);

-- Lightweight memory pointers. The actual memory rows live in @8gent/memory's
-- own SQLite file; this index lets the workspace DB cross-reference memories
-- by topic / scope without joining databases.
CREATE TABLE IF NOT EXISTS memory_index (
	id TEXT PRIMARY KEY,
	memory_id TEXT NOT NULL,
	scope TEXT NOT NULL,
	topic TEXT,
	importance REAL NOT NULL DEFAULT 0.5,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_index_memory ON memory_index(memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_index_scope ON memory_index(scope);
CREATE INDEX IF NOT EXISTS idx_memory_index_topic ON memory_index(topic);
`;

/**
 * Append-only list. Never reorder, never edit applied entries.
 * To evolve the schema, add a new entry with a higher version number.
 */
export const MIGRATIONS: Migration[] = [
	{
		version: 1,
		name: "init_core_tables",
		up: CORE_TABLES_SQL,
	},
];

/**
 * Apply any pending migrations. Idempotent and safe to call on every open.
 * Returns the list of versions that were applied during this call.
 */
export function applyMigrations(db: Database): number[] {
	db.exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY,
			name TEXT NOT NULL,
			applied_at INTEGER NOT NULL
		);
	`);

	const appliedRows = db
		.query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version ASC")
		.all();
	const applied = new Set(appliedRows.map((r) => r.version));

	const newlyApplied: number[] = [];
	const insertMigration = db.prepare(
		"INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
	);

	for (const migration of MIGRATIONS) {
		if (applied.has(migration.version)) continue;

		const tx = db.transaction(() => {
			db.exec(migration.up);
			insertMigration.run(migration.version, migration.name, Date.now());
		});
		tx();
		newlyApplied.push(migration.version);
	}

	return newlyApplied;
}

/** Current schema version (highest version in MIGRATIONS). */
export function targetSchemaVersion(): number {
	return MIGRATIONS.reduce((max, m) => (m.version > max ? m.version : max), 0);
}

/** Currently-applied schema version, or 0 if none applied. */
export function currentSchemaVersion(db: Database): number {
	try {
		const row = db
			.query<{ version: number }, []>(
				"SELECT MAX(version) as version FROM schema_migrations",
			)
			.get();
		return row?.version ?? 0;
	} catch {
		return 0;
	}
}
