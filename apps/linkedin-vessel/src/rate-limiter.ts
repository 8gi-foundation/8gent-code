/**
 * Rate Limiter - Per-account daily caps.
 * LinkedIn accounts get flagged if you hit certain thresholds.
 * These limits are conservative. Do not override them.
 */

import { Database } from "bun:sqlite";
import { getDb } from "./campaign-db";

const DAILY_CAPS = {
  connection_requests: 20,
  messages: 50,
  profile_views: 80,
} as const;

type ActionType = keyof typeof DAILY_CAPS;

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);  // YYYY-MM-DD
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
    const count = this.getCount(action);
    return count < DAILY_CAPS[action];
  }

  remaining(action: ActionType): number {
    return Math.max(0, DAILY_CAPS[action] - this.getCount(action));
  }

  consume(action: ActionType): boolean {
    if (!this.canSend(action)) return false;
    this.db.prepare(`
      INSERT INTO rate_limits (account_id, action_type, date_key, count)
      VALUES (?, ?, ?, 1)
      ON CONFLICT (account_id, action_type, date_key)
      DO UPDATE SET count = count + 1
    `).run(this.accountId, action, todayKey());
    return true;
  }

  getStatus(): Record<ActionType, { used: number; cap: number; remaining: number }> {
    const result = {} as any;
    for (const [action, cap] of Object.entries(DAILY_CAPS)) {
      const used = this.getCount(action as ActionType);
      result[action] = { used, cap, remaining: Math.max(0, cap - used) };
    }
    return result;
  }

  private getCount(action: ActionType): number {
    const row = this.db.prepare(`
      SELECT count FROM rate_limits
      WHERE account_id = ? AND action_type = ? AND date_key = ?
    `).get(this.accountId, action, todayKey()) as any;
    return row?.count ?? 0;
  }
}
