/**
 * CapabilityAuditStore - append-only SQLite log of skill capability grants and
 * revocations. Implements the audit acceptance criterion in issue #2091
 * (skill-as-permission widening).
 *
 * Design rules:
 *   - Append only. No public update/delete method.
 *   - Metadata only. No record content.
 *   - Cheap to write: single INSERT, WAL, NORMAL sync.
 *
 * Mirrors the SQLite patterns from packages/audit/store.ts and
 * packages/memory/store.ts. Kept in a separate table from the DPIA G7
 * child-record access log so the two audit streams stay independent.
 */

import { Database } from "bun:sqlite";
import type {
	ActorKind,
	CapabilityEvent,
	CapabilityOperation,
	LogCapabilityInput,
	QueryCapabilityOptions,
} from "./types.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS capability_audit_log (
  id            TEXT PRIMARY KEY,
  created_at    INTEGER NOT NULL,
  actor         TEXT NOT NULL,
  actor_kind    TEXT NOT NULL,
  skill         TEXT NOT NULL,
  capability    TEXT NOT NULL,
  operation     TEXT NOT NULL,
  reason        TEXT NOT NULL,
  session_id    TEXT
);
CREATE INDEX IF NOT EXISTS idx_cap_skill      ON capability_audit_log(skill);
CREATE INDEX IF NOT EXISTS idx_cap_capability ON capability_audit_log(capability);
CREATE INDEX IF NOT EXISTS idx_cap_actor      ON capability_audit_log(actor);
CREATE INDEX IF NOT EXISTS idx_cap_created_at ON capability_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cap_session    ON capability_audit_log(session_id);
`;

const VALID_OPERATIONS: readonly CapabilityOperation[] = ["grant", "revoke"];
const VALID_ACTOR_KINDS: readonly ActorKind[] = ["human", "agent", "system"];

function generateEventId(): string {
	return `cap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function assertValid(input: LogCapabilityInput): void {
	if (!input.actor) throw new Error("actor is required");
	if (!input.skill) throw new Error("skill is required");
	if (!input.capability) throw new Error("capability is required");
	if (!input.reason) throw new Error("reason is required");
	if (!VALID_ACTOR_KINDS.includes(input.actorKind)) {
		throw new Error(`invalid actorKind: ${input.actorKind}`);
	}
	if (!VALID_OPERATIONS.includes(input.operation)) {
		throw new Error(`invalid operation: ${input.operation}`);
	}
}

export class CapabilityAuditStore {
	private db: Database;

	constructor(dbPath: string) {
		this.db = new Database(dbPath, { create: true });
		try {
			this.db.exec("PRAGMA journal_mode = WAL");
			this.db.exec("PRAGMA synchronous = NORMAL");
			this.db.exec("PRAGMA foreign_keys = ON");
		} catch (err) {
			console.warn("[audit] capability PRAGMA init warning:", (err as Error).message);
		}
		this.db.exec(SCHEMA_SQL);
	}

	/** Record a single capability event. Append only. Returns the generated id. */
	logCapability(input: LogCapabilityInput): string {
		assertValid(input);
		const id = generateEventId();
		this.db
			.prepare(
				`INSERT INTO capability_audit_log
          (id, created_at, actor, actor_kind, skill, capability, operation, reason, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				Date.now(),
				input.actor,
				input.actorKind,
				input.skill,
				input.capability,
				input.operation,
				input.reason,
				input.sessionId ?? null,
			);
		return id;
	}

	/** Query the log. Read-only. Filters compose as AND. */
	queryCapability(options: QueryCapabilityOptions = {}): CapabilityEvent[] {
		type Bind = string | number | null;
		const clauses: string[] = [];
		const params: Bind[] = [];

		if (options.skill) {
			clauses.push("skill = ?");
			params.push(options.skill);
		}
		if (options.capability) {
			clauses.push("capability = ?");
			params.push(options.capability);
		}
		if (options.actor) {
			clauses.push("actor = ?");
			params.push(options.actor);
		}
		if (options.operation) {
			clauses.push("operation = ?");
			params.push(options.operation);
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
				`SELECT id, created_at, actor, actor_kind, skill, capability,
                operation, reason, session_id
           FROM capability_audit_log
           ${where}
           ORDER BY created_at DESC
           LIMIT ?`,
			)
			.all(...params, limit) as Array<{
			id: string;
			created_at: number;
			actor: string;
			actor_kind: string;
			skill: string;
			capability: string;
			operation: string;
			reason: string;
			session_id: string | null;
		}>;

		return rows.map((r) => ({
			id: r.id,
			createdAt: r.created_at,
			actor: r.actor,
			actorKind: r.actor_kind as ActorKind,
			skill: r.skill,
			capability: r.capability,
			operation: r.operation as CapabilityOperation,
			reason: r.reason,
			sessionId: r.session_id,
		}));
	}

	/** Total row count. Used by admin CLI and tests. */
	count(): number {
		const row = this.db.prepare("SELECT COUNT(*) AS n FROM capability_audit_log").get() as {
			n: number;
		};
		return row.n;
	}

	close(): void {
		this.db.close();
	}
}
