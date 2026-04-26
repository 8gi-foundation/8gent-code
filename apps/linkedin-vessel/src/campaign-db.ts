/**
 * Campaign DB - SQLite store for leads, campaigns, messages, templates.
 * Uses bun:sqlite with WAL mode. Persisted at /root/.8gent/linkedin.db on Fly.
 */

import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Campaign, Lead, MessageRecord, MessageTemplate } from "./types";

function getDbPath(): string {
	const base =
		process.env.EIGHT_DATA_DIR ||
		path.join(process.env.HOME || "/root", ".8gent");
	if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true });
	return path.join(base, "linkedin.db");
}

let _db: Database | null = null;

export function getDb(): Database {
	if (_db) return _db;
	_db = new Database(getDbPath());
	_db.exec("PRAGMA journal_mode = WAL;");
	_db.exec(`
    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      profile_url TEXT NOT NULL,
      public_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      title TEXT,
      company TEXT,
      location TEXT,
      signals TEXT NOT NULL DEFAULT '[]',
      connection_degree INTEGER,
      enriched_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icp TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      touch_sequence TEXT NOT NULL DEFAULT '[]',
      leads_total INTEGER NOT NULL DEFAULT 0,
      leads_contacted INTEGER NOT NULL DEFAULT 0,
      replies INTEGER NOT NULL DEFAULT 0,
      qualified INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS message_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      body TEXT NOT NULL,
      signal_hook TEXT,
      send_count INTEGER NOT NULL DEFAULT 0,
      reply_count INTEGER NOT NULL DEFAULT 0,
      reply_rate REAL NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      evolved_from_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS message_records (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      lead_id TEXT NOT NULL,
      template_id TEXT NOT NULL,
      touch_step INTEGER NOT NULL,
      body TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      replied INTEGER NOT NULL DEFAULT 0,
      replied_at TEXT,
      qualified INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id),
      FOREIGN KEY (lead_id) REFERENCES leads(id),
      FOREIGN KEY (template_id) REFERENCES message_templates(id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_campaign ON message_records(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_messages_template ON message_records(template_id);
    CREATE INDEX IF NOT EXISTS idx_templates_reply_rate ON message_templates(reply_rate);
  `);
	return _db;
}

// ── Leads ──────────────────────────────────────────────────────────────

export function upsertLead(lead: Lead): void {
	const db = getDb();
	db.prepare(`
    INSERT OR REPLACE INTO leads
      (id, profile_url, public_id, name, title, company, location, signals, connection_degree, enriched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
		lead.id,
		lead.profileUrl,
		lead.publicId,
		lead.name,
		lead.title,
		lead.company,
		lead.location,
		JSON.stringify(lead.signals),
		lead.connectionDegree,
		lead.enrichedAt,
	);
}

export function getLead(publicId: string): Lead | null {
	const db = getDb();
	const row = db
		.prepare("SELECT * FROM leads WHERE public_id = ?")
		.get(publicId) as any;
	if (!row) return null;
	return {
		...row,
		signals: JSON.parse(row.signals),
		profileUrl: row.profile_url,
		publicId: row.public_id,
		connectionDegree: row.connection_degree,
		enrichedAt: row.enriched_at,
	};
}

// ── Templates ─────────────────────────────────────────────────────────

export function getTemplates(type?: string): MessageTemplate[] {
	const db = getDb();
	const sql = type
		? "SELECT * FROM message_templates WHERE type = ? ORDER BY reply_rate DESC"
		: "SELECT * FROM message_templates ORDER BY reply_rate DESC";
	const rows = (
		type ? db.prepare(sql).all(type) : db.prepare(sql).all()
	) as any[];
	return rows.map(rowToTemplate);
}

export function upsertTemplate(t: MessageTemplate): void {
	const db = getDb();
	db.prepare(`
    INSERT OR REPLACE INTO message_templates
      (id, name, type, body, signal_hook, send_count, reply_count, reply_rate,
       version, evolved_from_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
		t.id,
		t.name,
		t.type,
		t.body,
		t.signalHook,
		t.sendCount,
		t.replyCount,
		t.replyRate,
		t.version,
		t.evolvedFromId,
		t.createdAt,
		t.updatedAt,
	);
}

export function recordSend(templateId: string): void {
	const db = getDb();
	db.prepare(`
    UPDATE message_templates
    SET send_count = send_count + 1,
        reply_rate = CAST(reply_count AS REAL) / (send_count + 1),
        updated_at = ?
    WHERE id = ?
  `).run(new Date().toISOString(), templateId);
}

export function recordReply(templateId: string): void {
	const db = getDb();
	db.prepare(`
    UPDATE message_templates
    SET reply_count = reply_count + 1,
        reply_rate = CAST(reply_count + 1 AS REAL) / send_count,
        updated_at = ?
    WHERE id = ?
  `).run(new Date().toISOString(), templateId);
}

function rowToTemplate(row: any): MessageTemplate {
	return {
		id: row.id,
		name: row.name,
		type: row.type,
		body: row.body,
		signalHook: row.signal_hook,
		sendCount: row.send_count,
		replyCount: row.reply_count,
		replyRate: row.reply_rate,
		version: row.version,
		evolvedFromId: row.evolved_from_id,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

// ── Stats ─────────────────────────────────────────────────────────────

export function getCampaignStats(campaignId?: string): Record<string, unknown> {
	const db = getDb();
	const where = campaignId ? "WHERE mr.campaign_id = ?" : "";
	const params = campaignId ? [campaignId] : [];

	const totals = db
		.prepare(`
    SELECT
      COUNT(*) as total_sent,
      SUM(replied) as total_replies,
      SUM(qualified) as total_qualified,
      CAST(SUM(replied) AS REAL) / MAX(COUNT(*), 1) as overall_reply_rate
    FROM message_records mr ${where}
  `)
		.get(...params) as any;

	const byTemplate = db
		.prepare(`
    SELECT
      mt.name,
      mt.type,
      mt.send_count,
      mt.reply_count,
      mt.reply_rate,
      mt.version
    FROM message_templates mt
    ORDER BY mt.reply_rate DESC
    LIMIT 10
  `)
		.all() as any[];

	return { totals, topTemplates: byTemplate };
}
