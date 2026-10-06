/**
 * Review queue + activity log.
 *
 * Every outward LinkedIn write (connection request, message) is queued here
 * and only runs after James approves it. On approval the action still has to
 * pass the kill switch, the daily cap and a minimum spacing between sends.
 *
 * The full text lives in the queue row only until a decision is made, then it
 * is cleared. The activity log is append-only (SQLite triggers refuse UPDATE
 * and DELETE) and holds a short preview, never the full text.
 */

import type { Database } from "bun:sqlite";
import { getDb } from "./campaign-db";
import { isKilled } from "./policy";
import { type ActionType, RateLimiter, dailyCap } from "./rate-limiter";

export type QueuedAction = "connection_requests" | "messages";

export interface QueueItem {
	id: string;
	actionType: QueuedAction;
	target: string;
	payload: Record<string, string> | null;
	preview: string;
	status: "pending" | "executing" | "executed" | "failed" | "rejected" | "expired";
	createdAt: string;
	decidedAt: string | null;
}

export type Executor = (
	payload: Record<string, string>,
) => Promise<{ success: boolean; error?: string }>;
export type Executors = Record<QueuedAction, Executor>;
export type Notifier = (item: QueueItem) => Promise<void>;

export const PREVIEW_CHARS = 40;
export const MAX_PENDING = 25;
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

const DEFAULT_SPACING_S: Record<QueuedAction, number> = {
	connection_requests: 120,
	messages: 60,
};

export function minSpacingMs(action: QueuedAction): number {
	const raw = process.env[`LINKEDIN_SPACING_S_${action.toUpperCase()}`];
	const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
	// May be raised by env, never lowered below the default.
	const s = Number.isFinite(n) ? Math.max(n, DEFAULT_SPACING_S[action]) : DEFAULT_SPACING_S[action];
	return s * 1000;
}

export function preview(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}...` : flat;
}

let tablesReady = false;

function db(): Database {
	const d = getDb();
	if (!tablesReady) {
		d.exec(`
      CREATE TABLE IF NOT EXISTS action_queue (
        id TEXT PRIMARY KEY,
        action_type TEXT NOT NULL,
        target TEXT NOT NULL,
        payload TEXT,
        preview TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        decided_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_queue_status ON action_queue(status);

      CREATE TABLE IF NOT EXISTS activity_log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        event TEXT NOT NULL,
        action_type TEXT,
        queue_id TEXT,
        target TEXT,
        preview TEXT,
        detail TEXT
      );
      CREATE TRIGGER IF NOT EXISTS activity_log_no_update
        BEFORE UPDATE ON activity_log
        BEGIN SELECT RAISE(ABORT, 'activity_log is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS activity_log_no_delete
        BEFORE DELETE ON activity_log
        BEGIN SELECT RAISE(ABORT, 'activity_log is append-only'); END;
    `);
		tablesReady = true;
	}
	return d;
}

export function logActivity(entry: {
	event: string;
	actionType?: string;
	queueId?: string;
	target?: string;
	preview?: string;
	detail?: string;
}): void {
	db()
		.prepare(
			`INSERT INTO activity_log (ts, event, action_type, queue_id, target, preview, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			new Date().toISOString(),
			entry.event,
			entry.actionType ?? null,
			entry.queueId ?? null,
			entry.target ? entry.target.slice(0, 200) : null,
			entry.preview ? preview(entry.preview) : null,
			entry.detail ? entry.detail.slice(0, 200) : null,
		);
}

export function readActivity(limit = 100): unknown[] {
	return db()
		.prepare("SELECT * FROM activity_log ORDER BY seq DESC LIMIT ?")
		.all(Math.min(Math.max(limit, 1), 500));
}

function rowToItem(row: any): QueueItem {
	return {
		id: row.id,
		actionType: row.action_type,
		target: row.target,
		payload: row.payload ? JSON.parse(row.payload) : null,
		preview: row.preview,
		status: row.status,
		createdAt: row.created_at,
		decidedAt: row.decided_at,
	};
}

function getItem(id: string): QueueItem | null {
	const row = db().prepare("SELECT * FROM action_queue WHERE id = ?").get(id);
	return row ? rowToItem(row) : null;
}

function closeItem(id: string, status: QueueItem["status"]): void {
	db()
		.prepare("UPDATE action_queue SET status = ?, payload = NULL, decided_at = ? WHERE id = ?")
		.run(status, new Date().toISOString(), id);
}

/** Mark pending items older than the TTL as expired and clear their text. */
export function expireStale(now = Date.now()): number {
	const cutoff = new Date(now - PENDING_TTL_MS).toISOString();
	const stale = db()
		.prepare("SELECT * FROM action_queue WHERE status = 'pending' AND created_at < ?")
		.all(cutoff)
		.map(rowToItem);
	for (const item of stale) {
		closeItem(item.id, "expired");
		logActivity({
			event: "expired",
			actionType: item.actionType,
			queueId: item.id,
			target: item.target,
		});
	}
	return stale.length;
}

export function listPending(): QueueItem[] {
	expireStale();
	return db()
		.prepare("SELECT * FROM action_queue WHERE status = 'pending' ORDER BY created_at ASC")
		.all()
		.map(rowToItem);
}

function pendingCount(action?: QueuedAction): number {
	const row = action
		? db()
				.prepare(
					"SELECT COUNT(*) AS n FROM action_queue WHERE status = 'pending' AND action_type = ?",
				)
				.get(action)
		: db().prepare("SELECT COUNT(*) AS n FROM action_queue WHERE status = 'pending'").get();
	return (row as any)?.n ?? 0;
}

function lastExecutedAt(action: QueuedAction): number | null {
	const row = db()
		.prepare(
			"SELECT MAX(decided_at) AS t FROM action_queue WHERE action_type = ? AND status IN ('executed', 'failed')",
		)
		.get(action) as any;
	return row?.t ? Date.parse(row.t) : null;
}

export type QueueOutcome =
	| { ok: true; item: QueueItem; message: string }
	| { ok: false; status: number; message: string; retryAfterS?: number };

export class ReviewQueue {
	private limiter: RateLimiter;

	constructor(
		accountId: string,
		private executors: Executors,
		private notify: Notifier,
	) {
		this.limiter = new RateLimiter(accountId);
	}

	async enqueue(
		actionType: QueuedAction,
		target: string,
		payload: Record<string, string>,
		text: string,
	): Promise<QueueOutcome> {
		if (isKilled())
			return { ok: false, status: 503, message: "Vessel is paused (kill switch on)." };
		expireStale();
		if (pendingCount() >= MAX_PENDING) {
			return { ok: false, status: 429, message: `Review queue is full (${MAX_PENDING} pending).` };
		}
		const cap = dailyCap(actionType as ActionType);
		if (this.limiter.used(actionType) + pendingCount(actionType) >= cap) {
			return {
				ok: false,
				status: 429,
				message: `Daily cap for ${actionType} (${cap}) is already used or queued.`,
			};
		}

		const item: QueueItem = {
			id: crypto.randomUUID(),
			actionType,
			target,
			payload,
			preview: preview(text),
			status: "pending",
			createdAt: new Date().toISOString(),
			decidedAt: null,
		};
		db()
			.prepare(
				`INSERT INTO action_queue (id, action_type, target, payload, preview, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
			)
			.run(item.id, actionType, target, JSON.stringify(payload), item.preview, item.createdAt);
		logActivity({ event: "queued", actionType, queueId: item.id, target, preview: text });

		try {
			await this.notify(item);
		} catch (e: any) {
			logActivity({ event: "notify_failed", queueId: item.id, detail: String(e?.message || e) });
		}
		return {
			ok: true,
			item,
			message: `Queued for approval (id ${item.id}). Nothing has been sent.`,
		};
	}

	async approve(id: string, now = Date.now()): Promise<QueueOutcome> {
		if (isKilled())
			return { ok: false, status: 503, message: "Vessel is paused (kill switch on)." };
		expireStale(now);
		const item = getItem(id);
		if (!item) return { ok: false, status: 404, message: "No such queue item." };
		if (item.status !== "pending") {
			return { ok: false, status: 409, message: `Item is ${item.status}, not pending.` };
		}

		if (!this.limiter.canSend(item.actionType)) {
			return {
				ok: false,
				status: 429,
				message: `Daily cap for ${item.actionType} reached. Item stays pending.`,
			};
		}
		const last = lastExecutedAt(item.actionType);
		const spacing = minSpacingMs(item.actionType);
		if (last !== null && now - last < spacing) {
			const retryAfterS = Math.ceil((spacing - (now - last)) / 1000);
			return {
				ok: false,
				status: 429,
				retryAfterS,
				message: `Too soon after the last ${item.actionType}. Retry in ${retryAfterS}s. Item stays pending.`,
			};
		}

		// Claim atomically so two approvals cannot both execute.
		const claimed = db()
			.prepare("UPDATE action_queue SET status = 'executing' WHERE id = ? AND status = 'pending'")
			.run(id);
		if (claimed.changes !== 1)
			return { ok: false, status: 409, message: "Item was already claimed." };

		logActivity({
			event: "approved",
			actionType: item.actionType,
			queueId: id,
			target: item.target,
		});
		let result: { success: boolean; error?: string };
		try {
			result = await this.executors[item.actionType](item.payload ?? {});
		} catch (e: any) {
			result = { success: false, error: String(e?.message || e) };
		}

		if (result.success) {
			this.limiter.consume(item.actionType);
			closeItem(id, "executed");
			logActivity({
				event: "executed",
				actionType: item.actionType,
				queueId: id,
				target: item.target,
			});
			return {
				ok: true,
				item: { ...item, status: "executed", payload: null },
				message: "Approved and sent.",
			};
		}
		closeItem(id, "failed");
		logActivity({
			event: "failed",
			actionType: item.actionType,
			queueId: id,
			target: item.target,
			detail: result.error,
		});
		return {
			ok: false,
			status: 502,
			message: `Approved, but the send failed: ${result.error ?? "unknown error"}`,
		};
	}

	reject(id: string): QueueOutcome {
		const item = getItem(id);
		if (!item) return { ok: false, status: 404, message: "No such queue item." };
		if (item.status !== "pending") {
			return { ok: false, status: 409, message: `Item is ${item.status}, not pending.` };
		}
		closeItem(id, "rejected");
		logActivity({
			event: "rejected",
			actionType: item.actionType,
			queueId: id,
			target: item.target,
		});
		return {
			ok: true,
			item: { ...item, status: "rejected", payload: null },
			message: "Rejected. Nothing was sent.",
		};
	}
}
