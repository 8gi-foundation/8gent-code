/**
 * @8gent/db/workspace — Workspace-shared SQLite database.
 *
 * Public surface for harness and host processes that need to read/write
 * workspace-local state at `.8gent/state.db`.
 */

export {
	WorkspaceDb,
	closeWorkspaceDb,
	getWorkspaceDb,
	resolveWorkspaceDbPath,
	type AgentChannel,
	type AgentSessionRecord,
	type AgentSessionStatus,
	type AppStateEntry,
	type KvEntry,
	type MemoryIndexEntry,
	type SkillStateEntry,
	type StartAgentSessionInput,
	type UpdateAgentSessionInput,
	type UpsertMemoryIndexInput,
	type WorkspaceDbOptions,
} from "./workspace-db.js";

export {
	MIGRATIONS,
	applyMigrations,
	currentSchemaVersion,
	targetSchemaVersion,
	type Migration,
} from "./migrations.js";
