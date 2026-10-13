/**
 * Rate Limiter - Per-account daily caps.
 * LinkedIn accounts get flagged if you hit certain thresholds.
 * These limits are conservative. Do not override them.
 */

import type { Database } from "bun:sqlite";
import { getDb } from "./campaign-db";

// Hard ceilings. An env var may lower a cap, never raise it above these.
const DAILY_CAPS = {
	connection_requests: 20,
	messages: 50,
	profile_views: 80,
} as const;

export type ActionType = keyof typeof DAILY_CAPS;

export function dailyCap(action: ActionType): number {
	const hard = DAILY_CAPS[action];
	const raw = process.env[`LINKEDIN_CAP_${action.toUpperCase()}`];
	if (raw === undefined || raw === "") return hard;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n < 0) return hard;
	return Math.min(n, hard);
}

function todayKey(): string {
	return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function ensureTable(db: Database): void {
	db.exec(`
    CREATE TABLE IF NOT EXISTS rate_limits (
      account_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      date_key TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (account_id, action_type, date_key)
    );
  `);
}

export class RateLimiter {
	private accountId: string;
	private db: Database;

	constructor(accountId: string) {
		this.accountId = accountId;
		this.db = getDb();
		ensureTable(this.db);
	}

	canSend(action: ActionType): boolean {
		return this.getCount(action) < dailyCap(action);
	}

	remaining(action: ActionType): number {
		return Math.max(0, dailyCap(action) - this.getCount(action));
	}

	consume(action: ActionType): boolean {
		if (!this.canSend(action)) return false;
		this.db
			.prepare(`
      INSERT INTO rate_limits (account_id, action_type, date_key, count)
      VALUES (?, ?, ?, 1)
      ON CONFLICT (account_id, action_type, date_key)
      DO UPDATE SET count = count + 1
    `)
			.run(this.accountId, action, todayKey());
		return true;
	}

	getStatus(): Record<ActionType, { used: number; cap: number; remaining: number }> {
		const result = {} as any;
		for (const action of Object.keys(DAILY_CAPS) as ActionType[]) {
			const cap = dailyCap(action);
			const used = this.getCount(action);
			result[action] = { used, cap, remaining: Math.max(0, cap - used) };
		}
		return result;
	}

	/** Give back a slot reserved by consume() when the send did not happen. */
	release(action: ActionType): void {
		this.db
			.prepare(`
      UPDATE rate_limits SET count = count - 1
      WHERE account_id = ? AND action_type = ? AND date_key = ? AND count > 0
    `)
			.run(this.accountId, action, todayKey());
	}

	used(action: ActionType): number {
		return this.getCount(action);
	}

	private getCount(action: ActionType): number {
		const row = this.db
			.prepare(`
      SELECT count FROM rate_limits
      WHERE account_id = ? AND action_type = ? AND date_key = ?
    `)
			.get(this.accountId, action, todayKey()) as any;
		return row?.count ?? 0;
	}
}
