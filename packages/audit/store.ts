/**
 * AccessAuditStore - append-only SQLite-backed access audit log.
 *
 * Design rules (DPIA G7):
 *   - Append only. No public update/delete method.
 *   - Metadata only. Never persist record content.
 *   - Cheap to write: single INSERT, WAL, NORMAL sync.
 *
 * Follows the SQLite patterns from packages/memory/store.ts.
 */

import { Database } from "bun:sqlite";
import type {
	AccessEvent,
	AccessOperation,
	ActorKind,
	LogAccessInput,
	QueryAccessOptions,
} from "./types.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS access_audit_log (
  id            TEXT PRIMARY KEY,
  created_at    INTEGER NOT NULL,
  actor         TEXT NOT NULL,
  actor_kind    TEXT NOT NULL,
  target_table  TEXT NOT NULL,
  target_id     TEXT NOT NULL,
  operation     TEXT NOT NULL,
  reason        TEXT NOT NULL,
  session_id    TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_target     ON access_audit_log(target_table, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_actor      ON access_audit_log(actor);
CREATE INDEX IF NOT EXISTS idx_audit_created_at ON access_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_session    ON access_audit_log(session_id);
`;

const VALID_OPERATIONS: readonly AccessOperation[] = [
	"read",
	"derive",
	"export",
];
const VALID_ACTOR_KINDS: readonly ActorKind[] = ["human", "agent", "system"];

function generateEventId(): string {
	return `aud_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function assertValid(input: LogAccessInput): void {
	if (!input.actor) throw new Error("actor is required");
	if (!input.targetTable) throw new Error("targetTable is required");
	if (!input.targetId) throw new Error("targetId is required");
	if (!input.reason) throw new Error("reason is required");
	if (!VALID_ACTOR_KINDS.includes(input.actorKind)) {
		throw new Error(`invalid actorKind: ${input.actorKind}`);
	}
	if (!VALID_OPERATIONS.includes(input.operation)) {
		throw new Error(`invalid operation: ${input.operation}`);
	}
}

export class AccessAuditStore {
	private db: Database;

	constructor(dbPath: string) {
		this.db = new Database(dbPath, { create: true });
		try {
			this.db.exec("PRAGMA journal_mode = WAL");
			this.db.exec("PRAGMA synchronous = NORMAL");
			this.db.exec("PRAGMA foreign_keys = ON");
		} catch (err) {
			console.warn("[audit] PRAGMA init warning:", (err as Error).message);
		}
		this.db.exec(SCHEMA_SQL);
	}

	/** Record a single access event. Append only. Returns the generated id. */
	logAccess(input: LogAccessInput): string {
		assertValid(input);
		const id = generateEventId();
		this.db
			.prepare(
				`INSERT INTO access_audit_log
          (id, created_at, actor, actor_kind, target_table, target_id, operation, reason, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				Date.now(),
				input.actor,
				input.actorKind,
				input.targetTable,
				input.targetId,
				input.operation,
				input.reason,
				input.sessionId ?? null,
			);
		return id;
	}

	/** Query the log. Read-only. Filters compose as AND. */
	queryAccess(options: QueryAccessOptions = {}): AccessEvent[] {
		type Bind = string | number | null;
		const clauses: string[] = [];
		const params: Bind[] = [];

		if (options.targetId) {
			clauses.push("target_id = ?");
			params.push(options.targetId);
		}
		if (options.targetTable) {
			clauses.push("target_table = ?");
			params.push(options.targetTable);
		}
		if (options.actor) {
			clauses.push("actor = ?");
			params.push(options.actor);
		}
		if (typeof options.since === "number") {
			clauses.push("created_at >= ?");
			params.push(options.since);
		}
		if (typeof options.until === "number") {
			clauses.push("created_at <= ?");
			params.push(options.until);
		}

		const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
		const limit = Math.min(Math.max(options.limit ?? 500, 1), 10000);

		const rows = this.db
			.prepare(
				`SELECT id, created_at, actor, actor_kind, target_table, target_id,
                operation, reason, session_id
           FROM access_audit_log
           ${where}
           ORDER BY created_at DESC
           LIMIT ?`,
			)
			.all(...params, limit) as Array<{
			id: string;
			created_at: number;
			actor: string;
			actor_kind: string;
			target_table: string;
			target_id: string;
			operation: string;
			reason: string;
			session_id: string | null;
		}>;

		return rows.map((r) => ({
			id: r.id,
			createdAt: r.created_at,
			actor: r.actor,
			actorKind: r.actor_kind as ActorKind,
			targetTable: r.target_table,
			targetId: r.target_id,
			operation: r.operation as AccessOperation,
			reason: r.reason,
			sessionId: r.session_id,
		}));
	}

	/** Total row count. Used by admin CLI and tests. */
	count(): number {
		const row = this.db
			.prepare(`SELECT COUNT(*) AS n FROM access_audit_log`)
			.get() as { n: number };
		return row.n;
	}

	close(): void {
		this.db.close();
	}
}
