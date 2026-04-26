/**
 * Evolution DB — SQLite store for session reflections and learned skills.
 * Uses bun:sqlite. No external deps.
 */

import { Database } from "bun:sqlite";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ============================================
// Types
// ============================================

export interface SessionReflection {
	sessionId: string;
	timestamp: string;
	toolsUsed: string[];
	errorsEncountered: string[];
	patternsObserved: string[];
	skillsLearned: string[];
	successRate: number;
}

export interface LearnedSkill {
	id: string;
	trigger: string;
	action: string;
	confidence: number;
	timesUsed: number;
	lastUsed: string;
	source: string;
}

// ============================================
// DB Setup
// ============================================

function getDbPath(): string {
	const base = process.env.EIGHT_DATA_DIR || path.join(os.homedir(), ".8gent");
	const dir = path.join(base, "evolution");
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	return path.join(dir, "evolution.db");
}

let _db: Database | null = null;

/** Close and clear the cached DB handle. Required for test isolation. */
export function resetDb(): void {
	if (_db) {
		_db.close();
		_db = null;
	}
}

export function getDb(): Database {
	if (_db) return _db;
	_db = new Database(getDbPath());
	_db.exec(`
    CREATE TABLE IF NOT EXISTS reflections (
      session_id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      tools_used TEXT NOT NULL,
      errors_encountered TEXT NOT NULL,
      patterns_observed TEXT NOT NULL,
      skills_learned TEXT NOT NULL,
      success_rate REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS learned_skills (
      id TEXT PRIMARY KEY,
      trigger TEXT NOT NULL,
      action TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.5,
      times_used INTEGER NOT NULL DEFAULT 0,
      last_used TEXT NOT NULL,
      source TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS evolution_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      subject TEXT NOT NULL,
      value REAL,
      metadata TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_skills_confidence ON learned_skills(confidence DESC);
    CREATE INDEX IF NOT EXISTS idx_events_type ON evolution_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_events_subject ON evolution_events(subject);
    CREATE INDEX IF NOT EXISTS idx_events_session ON evolution_events(session_id);
  `);

	// Seed default schema version if not already set
	const existing = _db
		.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
		.get() as any;
	if (!existing) {
		_db
			.prepare(
				"INSERT INTO schema_meta (key, value) VALUES ('schema_version', '1')",
			)
			.run();
	}

	return _db;
}

// ============================================
// Reflections
// ============================================

export function saveReflection(r: SessionReflection): void {
	const db = getDb();
	db.prepare(`
    INSERT OR REPLACE INTO reflections
    (session_id, timestamp, tools_used, errors_encountered, patterns_observed, skills_learned, success_rate)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
		r.sessionId,
		r.timestamp,
		JSON.stringify(r.toolsUsed),
		JSON.stringify(r.errorsEncountered),
		JSON.stringify(r.patternsObserved),
		JSON.stringify(r.skillsLearned),
		r.successRate,
	);
}

export function getReflection(sessionId: string): SessionReflection | null {
	const db = getDb();
	const row = db
		.prepare("SELECT * FROM reflections WHERE session_id = ?")
		.get(sessionId) as any;
	if (!row) return null;
	return deserializeReflection(row);
}

export function getRecentReflections(limit = 20): SessionReflection[] {
	const db = getDb();
	const rows = db
		.prepare("SELECT * FROM reflections ORDER BY timestamp DESC LIMIT ?")
		.all(limit) as any[];
	return rows.map(deserializeReflection);
}

function deserializeReflection(row: any): SessionReflection {
	return {
		sessionId: row.session_id,
		timestamp: row.timestamp,
		toolsUsed: JSON.parse(row.tools_used),
		errorsEncountered: JSON.parse(row.errors_encountered),
		patternsObserved: JSON.parse(row.patterns_observed),
		skillsLearned: JSON.parse(row.skills_learned),
		successRate: row.success_rate,
	};
}

// ============================================
// Learned Skills
// ============================================

export function saveSkill(skill: LearnedSkill): void {
	const db = getDb();
	db.prepare(`
    INSERT OR REPLACE INTO learned_skills
    (id, trigger, action, confidence, times_used, last_used, source)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
		skill.id,
		skill.trigger,
		skill.action,
		skill.confidence,
		skill.timesUsed,
		skill.lastUsed,
		skill.source,
	);
}

export function getSkillById(id: string): LearnedSkill | null {
	const db = getDb();
	const row = db
		.prepare("SELECT * FROM learned_skills WHERE id = ?")
		.get(id) as any;
	return row ? deserializeSkill(row) : null;
}

export function getAllSkills(): LearnedSkill[] {
	const db = getDb();
	const rows = db
		.prepare("SELECT * FROM learned_skills ORDER BY confidence DESC")
		.all() as any[];
	return rows.map(deserializeSkill);
}

export function querySkillsByTrigger(triggerFragment: string): LearnedSkill[] {
	const db = getDb();
	const rows = db
		.prepare(
			"SELECT * FROM learned_skills WHERE LOWER(trigger) LIKE ? ORDER BY confidence DESC",
		)
		.all(`%${triggerFragment.toLowerCase()}%`) as any[];
	return rows.map(deserializeSkill);
}

export function updateSkillStats(id: string, success: boolean): void {
	const skill = getSkillById(id);
	if (!skill) return;
	const newTimesUsed = skill.timesUsed + 1;
	// Bayesian update: move confidence toward 1 on success, toward 0 on failure
	const delta = success ? 0.1 : -0.1;
	const newConfidence = Math.max(0, Math.min(1, skill.confidence + delta));
	getDb()
		.prepare(
			"UPDATE learned_skills SET confidence = ?, times_used = ?, last_used = ? WHERE id = ?",
		)
		.run(newConfidence, newTimesUsed, new Date().toISOString(), id);
}

function deserializeSkill(row: any): LearnedSkill {
	return {
		id: row.id,
		trigger: row.trigger,
		action: row.action,
		confidence: row.confidence,
		timesUsed: row.times_used,
		lastUsed: row.last_used,
		source: row.source,
	};
}

// ============================================
// Evolution Events
// ============================================

type EventType =
	| "skill_learned"
	| "skill_used"
	| "pattern_discovered"
	| "error_encountered"
	| "confidence_change";

function generateEventId(): string {
	return `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function recordEvent(event: {
	sessionId: string;
	eventType: EventType;
	subject: string;
	value?: number;
	metadata?: Record<string, unknown>;
}): string {
	const db = getDb();
	const id = generateEventId();
	const now = new Date().toISOString();
	db.prepare(`
    INSERT INTO evolution_events (id, session_id, event_type, subject, value, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
		id,
		event.sessionId,
		event.eventType,
		event.subject,
		event.value ?? null,
		event.metadata ? JSON.stringify(event.metadata) : null,
		now,
	);
	return id;
}

export function getSkillHistory(
	skillId: string,
): Array<{ timestamp: string; confidence: number; sessionId: string }> {
	const db = getDb();
	const rows = db
		.prepare(
			`SELECT created_at, value, session_id FROM evolution_events
       WHERE event_type = 'confidence_change' AND subject = ?
       ORDER BY created_at ASC`,
		)
		.all(skillId) as any[];
	return rows.map((r: any) => ({
		timestamp: r.created_at,
		confidence: r.value ?? 0,
		sessionId: r.session_id,
	}));
}

export function getPatternFrequency(pattern: string): {
	firstSeen: string;
	lastSeen: string;
	count: number;
	sessions: string[];
} {
	const db = getDb();
	const rows = db
		.prepare(
			`SELECT created_at, session_id FROM evolution_events
       WHERE event_type = 'pattern_discovered' AND subject = ?
       ORDER BY created_at ASC`,
		)
		.all(pattern) as any[];

	if (rows.length === 0) {
		return { firstSeen: "", lastSeen: "", count: 0, sessions: [] };
	}

	return {
		firstSeen: rows[0].created_at,
		lastSeen: rows[rows.length - 1].created_at,
		count: rows.length,
		sessions: rows.map((r: any) => r.session_id),
	};
}

export function getEvolutionSummary(since: string): {
	newSkills: number;
	improvedSkills: number;
	degradedSkills: number;
	newPatterns: number;
	errorRate: number;
} {
	const db = getDb();

	const countByType = (type: string): number => {
		const row = db
			.prepare(
				`SELECT COUNT(*) as cnt FROM evolution_events
         WHERE event_type = ? AND created_at >= ?`,
			)
			.get(type, since) as any;
		return row?.cnt ?? 0;
	};

	const newSkills = countByType("skill_learned");
	const newPatterns = countByType("pattern_discovered");

	// Improved vs degraded: confidence_change events with positive vs negative value
	const improved = db
		.prepare(
			`SELECT COUNT(DISTINCT subject) as cnt FROM evolution_events
       WHERE event_type = 'confidence_change' AND value > 0 AND created_at >= ?`,
		)
		.get(since) as any;
	const degraded = db
		.prepare(
			`SELECT COUNT(DISTINCT subject) as cnt FROM evolution_events
       WHERE event_type = 'confidence_change' AND value < 0 AND created_at >= ?`,
		)
		.get(since) as any;

	// Error rate: errors / total events in period
	const totalEvents = db
		.prepare(
			"SELECT COUNT(*) as cnt FROM evolution_events WHERE created_at >= ?",
		)
		.get(since) as any;
	const errorCount = countByType("error_encountered");
	const total = totalEvents?.cnt ?? 0;
	const errorRate = total > 0 ? errorCount / total : 0;

	return {
		newSkills,
		improvedSkills: improved?.cnt ?? 0,
		degradedSkills: degraded?.cnt ?? 0,
		newPatterns,
		errorRate,
	};
}

// ============================================
// Schema Versioning
// ============================================

export function getSchemaVersion(): number {
	const db = getDb();
	const row = db
		.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
		.get() as any;
	return row ? Number.parseInt(row.value, 10) : 1;
}

export function setSchemaVersion(version: number): void {
	const db = getDb();
	db.prepare(
		"INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', ?)",
	).run(String(version));
}
