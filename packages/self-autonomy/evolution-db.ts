/**
 * Evolution DB — SQLite store for session reflections and learned skills.
 * Uses bun:sqlite. No external deps.
 */

import { Database } from "bun:sqlite";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

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

    CREATE INDEX IF NOT EXISTS idx_skills_confidence ON learned_skills(confidence DESC);
  `);
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
  const row = db.prepare("SELECT * FROM reflections WHERE session_id = ?").get(sessionId) as any;
  if (!row) return null;
  return deserializeReflection(row);
}

export function getRecentReflections(limit: number = 20): SessionReflection[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM reflections ORDER BY timestamp DESC LIMIT ?").all(limit) as any[];
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
  `).run(skill.id, skill.trigger, skill.action, skill.confidence, skill.timesUsed, skill.lastUsed, skill.source);
}

export function getSkillById(id: string): LearnedSkill | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM learned_skills WHERE id = ?").get(id) as any;
  return row ? deserializeSkill(row) : null;
}

export function getAllSkills(): LearnedSkill[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM learned_skills ORDER BY confidence DESC").all() as any[];
  return rows.map(deserializeSkill);
}

export function querySkillsByTrigger(triggerFragment: string): LearnedSkill[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM learned_skills WHERE LOWER(trigger) LIKE ? ORDER BY confidence DESC",
  ).all(`%${triggerFragment.toLowerCase()}%`) as any[];
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
    .prepare("UPDATE learned_skills SET confidence = ?, times_used = ?, last_used = ? WHERE id = ?")
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
