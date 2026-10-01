/**
 * DecisionAuditStore - tamper-evident, append-only SQLite log of tool-call
 * policy decisions (NemoClaw v2, issue #2756 step 3).
 *
 * Every entry is hash-chained: entry_hash = SHA-256(prev_hash + canonical
 * payload). The chain makes the log tamper-EVIDENT, not tamper-proof:
 *
 *   - Editing any persisted field breaks that entry's recomputed hash.
 *   - Deleting or reordering an interior entry breaks the seq/prev linkage.
 *   - Truncating the TAIL is only detectable against an externally anchored
 *     head - callers that need truncation evidence should periodically read
 *     {@link DecisionAuditStore.head} and anchor it outside this database
 *     (daemon state, Flow, a remote log). verifyChain() reports the current
 *     head for exactly that purpose.
 *
 * Design rules (match store.ts / capability-store.ts):
 *   - Append only. No public update/delete method.
 *   - Metadata only. Callers scrub secrets BEFORE logging (the permissions
 *     package scrubs with goal-secret-scrub; this package stays dependency-free
 *     to avoid a permissions <-> audit cycle).
 *   - Cheap to write: single INSERT inside a transaction, WAL, NORMAL sync.
 */

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { SqliteDatabase } from "../core/sqlite";
import type {
	ChainVerification,
	DecisionEvent,
	DecisionGate,
	DecisionOutcome,
	DecisionRequestKind,
	LogDecisionInput,
	QueryDecisionOptions,
} from "./types.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS policy_decision_log (
  seq            INTEGER PRIMARY KEY,
  created_at     INTEGER NOT NULL,
  session_id     TEXT,
  actor          TEXT NOT NULL,
  tool           TEXT NOT NULL,
  request_kind   TEXT NOT NULL,
  request_detail TEXT NOT NULL,
  decision       TEXT NOT NULL,
  gate           TEXT NOT NULL,
  reason         TEXT NOT NULL,
  prev_hash      TEXT NOT NULL,
  entry_hash     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dec_tool       ON policy_decision_log(tool);
CREATE INDEX IF NOT EXISTS idx_dec_session    ON policy_decision_log(session_id);
CREATE INDEX IF NOT EXISTS idx_dec_decision   ON policy_decision_log(decision);
CREATE INDEX IF NOT EXISTS idx_dec_created_at ON policy_decision_log(created_at DESC);
`;

/** prev_hash of the first entry in the chain. */
export const GENESIS_HASH = "0".repeat(64);

const VALID_DECISIONS: readonly DecisionOutcome[] = ["allow", "deny"];
const VALID_KINDS: readonly DecisionRequestKind[] = ["fs_read", "fs_write", "network", "exec"];
const VALID_GATES: readonly DecisionGate[] = ["capability-manifest", "policy-rules"];

interface Row {
	seq: number;
	created_at: number;
	session_id: string | null;
	actor: string;
	tool: string;
	request_kind: DecisionRequestKind;
	request_detail: string;
	decision: DecisionOutcome;
	gate: DecisionGate;
	reason: string;
	prev_hash: string;
	entry_hash: string;
}

/**
 * Canonical payload for hashing. A JSON array (not object) so field order
 * is fixed by construction, not by key insertion order.
 */
function canonicalPayload(row: Omit<Row, "prev_hash" | "entry_hash">): string {
	return JSON.stringify([
		row.seq,
		row.created_at,
		row.session_id,
		row.actor,
		row.tool,
		row.request_kind,
		row.request_detail,
		row.decision,
		row.gate,
		row.reason,
	]);
}

function chainHash(prevHash: string, payload: string): string {
	return createHash("sha256").update(`${prevHash}\n${payload}`).digest("hex");
}

function assertValid(input: LogDecisionInput): void {
	if (!input.tool) throw new Error("tool is required");
	if (!input.actor) throw new Error("actor is required");
	if (!input.reason) throw new Error("reason is required");
	if (typeof input.requestDetail !== "string") {
		throw new Error("requestDetail is required (empty string is fine)");
	}
	if (!VALID_DECISIONS.includes(input.decision)) {
		throw new Error(`invalid decision: ${input.decision}`);
	}
	if (!VALID_KINDS.includes(input.requestKind)) {
		throw new Error(`invalid requestKind: ${input.requestKind}`);
	}
	if (!VALID_GATES.includes(input.gate)) {
		throw new Error(`invalid gate: ${input.gate}`);
	}
}

function toEvent(row: Row): DecisionEvent {
	return {
		seq: row.seq,
		createdAt: row.created_at,
		sessionId: row.session_id,
		actor: row.actor,
		tool: row.tool,
		requestKind: row.request_kind,
		requestDetail: row.request_detail,
		decision: row.decision,
		gate: row.gate,
		reason: row.reason,
		prevHash: row.prev_hash,
		entryHash: row.entry_hash,
	};
}

export class DecisionAuditStore {
	private db: Database;

	constructor(dbPath: string) {
		this.db = new SqliteDatabase(dbPath, { create: true });
		try {
			this.db.exec("PRAGMA journal_mode = WAL");
			this.db.exec("PRAGMA synchronous = NORMAL");
		} catch (err) {
			console.warn("[audit] PRAGMA init warning:", (err as Error).message);
		}
		this.db.exec(SCHEMA_SQL);
	}

	/**
	 * Append one decision to the chain. Head read + insert run inside a
	 * transaction so the prev_hash linkage cannot race. Returns the entry.
	 */
	logDecision(input: LogDecisionInput): DecisionEvent {
		assertValid(input);
		const insert = this.db.transaction((): DecisionEvent => {
			const head = this.headRow();
			const seq = (head?.seq ?? 0) + 1;
			const prevHash = head?.entry_hash ?? GENESIS_HASH;
			const partial: Omit<Row, "prev_hash" | "entry_hash"> = {
				seq,
				created_at: Date.now(),
				session_id: input.sessionId ?? null,
				actor: input.actor,
				tool: input.tool,
				request_kind: input.requestKind,
				request_detail: input.requestDetail,
				decision: input.decision,
				gate: input.gate,
				reason: input.reason,
			};
			const entryHash = chainHash(prevHash, canonicalPayload(partial));
			this.db
				.prepare(
					`INSERT INTO policy_decision_log
            (seq, created_at, session_id, actor, tool, request_kind, request_detail,
             decision, gate, reason, prev_hash, entry_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					partial.seq,
					partial.created_at,
					partial.session_id,
					partial.actor,
					partial.tool,
					partial.request_kind,
					partial.request_detail,
					partial.decision,
					partial.gate,
					partial.reason,
					prevHash,
					entryHash,
				);
			return toEvent({ ...partial, prev_hash: prevHash, entry_hash: entryHash });
		});
		return insert();
	}

	/** Query the log. Read-only. Filters compose as AND. Newest first. */
	queryDecisions(options: QueryDecisionOptions = {}): DecisionEvent[] {
		type Bind = string | number | null;
		const clauses: string[] = [];
		const params: Bind[] = [];

		if (options.tool) {
			clauses.push("tool = ?");
			params.push(options.tool);
		}
		if (options.sessionId) {
			clauses.push("session_id = ?");
			params.push(options.sessionId);
		}
		if (options.decision) {
			clauses.push("decision = ?");
			params.push(options.decision);
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
		const limit = Math.max(1, Math.min(options.limit ?? 200, 10_000));
		const rows = this.db
			.prepare(`SELECT * FROM policy_decision_log ${where} ORDER BY seq DESC LIMIT ?`)
			.all(...params, limit) as Row[];
		return rows.map(toEvent);
	}

	/**
	 * Walk the entire chain in seq order and recompute every hash.
	 * Any edit, interior deletion, or reorder is reported with the seq of
	 * the first broken link. Tail truncation requires comparing the returned
	 * head hash against an externally anchored value (see module doc).
	 */
	verifyChain(): ChainVerification {
		const rows = this.db
			.prepare("SELECT * FROM policy_decision_log ORDER BY seq ASC")
			.all() as Row[];

		let expectedPrev = GENESIS_HASH;
		let expectedSeq = 1;
		for (const row of rows) {
			if (row.seq !== expectedSeq) {
				return {
					valid: false,
					entries: rows.length,
					brokenAtSeq: row.seq,
					reason: `sequence gap: expected seq ${expectedSeq}, found ${row.seq} (entry deleted or reordered)`,
				};
			}
			if (row.prev_hash !== expectedPrev) {
				return {
					valid: false,
					entries: rows.length,
					brokenAtSeq: row.seq,
					reason: `broken link at seq ${row.seq}: prev_hash does not match the previous entry`,
				};
			}
			const recomputed = chainHash(
				row.prev_hash,
				canonicalPayload({
					seq: row.seq,
					created_at: row.created_at,
					session_id: row.session_id,
					actor: row.actor,
					tool: row.tool,
					request_kind: row.request_kind,
					request_detail: row.request_detail,
					decision: row.decision,
					gate: row.gate,
					reason: row.reason,
				}),
			);
			if (recomputed !== row.entry_hash) {
				return {
					valid: false,
					entries: rows.length,
					brokenAtSeq: row.seq,
					reason: `hash mismatch at seq ${row.seq}: entry was modified after it was written`,
				};
			}
			expectedPrev = row.entry_hash;
			expectedSeq += 1;
		}

		return {
			valid: true,
			entries: rows.length,
			headHash: rows.length > 0 ? rows[rows.length - 1].entry_hash : GENESIS_HASH,
		};
	}

	/**
	 * Current chain head, for external anchoring (the only defence against
	 * tail truncation). Null when the log is empty.
	 */
	head(): { seq: number; entryHash: string } | null {
		const row = this.headRow();
		return row ? { seq: row.seq, entryHash: row.entry_hash } : null;
	}

	/** Total entries. */
	count(): number {
		const row = this.db.prepare("SELECT COUNT(*) as n FROM policy_decision_log").get() as {
			n: number;
		};
		return row.n;
	}

	close(): void {
		this.db.close();
	}

	private headRow(): Row | null {
		return (
			(this.db.prepare("SELECT * FROM policy_decision_log ORDER BY seq DESC LIMIT 1").get() as
				| Row
				| undefined) ?? null
		);
	}
}
