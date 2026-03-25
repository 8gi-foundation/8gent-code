/**
 * 8gent Code - NemoClaw Permission Audit Log
 *
 * Persistent SQLite audit trail for every permission check the policy engine performs.
 * Stores action, tool, decision, context snapshot, rule matched, and timing.
 * Supports query by tool, decision, and time window plus escalation pattern detection.
 *
 * Usage:
 *   import { AuditLog } from "@8gent/permissions/audit-log";
 *   const audit = new AuditLog();
 *   audit.record({ action: "run_command", tool: "bash", decision: "block", ... });
 *   const report = audit.exportReport();
 */

import { Database } from "bun:sqlite";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import type { PolicyActionType, PolicyContext } from "./types.js";

// ============================================
// Types
// ============================================

export type AuditDecision = "allow" | "block" | "require_approval" | "approved" | "denied";

export interface AuditEntry {
  id?: number;
  ts: string;
  action: string;
  tool: string;
  decision: AuditDecision;
  rule_matched: string | null;
  context_snapshot: string;
  prompted: boolean;
  infinite_mode: boolean;
  eval_ms: number;
  session_id: string | null;
}

export interface QueryFilters {
  tool?: string;
  decision?: AuditDecision;
  since?: number;
  until?: number;
  limit?: number;
}

export interface EscalationPattern {
  tool: string;
  escalation_count: number;
  last_escalation: string;
  decisions: Record<string, number>;
}

export interface AuditReport {
  generated_at: string;
  window_start: string;
  window_end: string;
  total_checks: number;
  by_decision: Record<AuditDecision, number>;
  by_tool: Record<string, number>;
  escalation_patterns: EscalationPattern[];
  top_blocked_tools: Array<{ tool: string; count: number }>;
  infinite_mode_checks: number;
  prompted_checks: number;
  avg_eval_ms: number;
  entries: AuditEntry[];
}

// ============================================
// Constants
// ============================================

const DEFAULT_DB_PATH = path.join(
  process.env.EIGHT_DATA_DIR || path.join(os.homedir(), ".8gent"),
  "permission-audit.db"
);

const REDACTED_FIELDS = ["password", "token", "secret", "key", "api_key", "auth", "credential"];
const MAX_CONTEXT_BYTES = 2048;

// ============================================
// AuditLog class
// ============================================

export class AuditLog {
  private db: Database;
  readonly dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? DEFAULT_DB_PATH;
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA synchronous=NORMAL");
    this._initSchema();
  }

  private _initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_entries (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        ts               TEXT    NOT NULL,
        action           TEXT    NOT NULL,
        tool             TEXT    NOT NULL,
        decision         TEXT    NOT NULL,
        rule_matched     TEXT,
        context_snapshot TEXT    NOT NULL DEFAULT '{}',
        prompted         INTEGER NOT NULL DEFAULT 0,
        infinite_mode    INTEGER NOT NULL DEFAULT 0,
        eval_ms          REAL    NOT NULL DEFAULT 0,
        session_id       TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_audit_ts       ON audit_entries(ts);
      CREATE INDEX IF NOT EXISTS idx_audit_tool     ON audit_entries(tool);
      CREATE INDEX IF NOT EXISTS idx_audit_decision ON audit_entries(decision);
      CREATE INDEX IF NOT EXISTS idx_audit_session  ON audit_entries(session_id);
    `);
  }

  /**
   * Record a single permission check outcome.
   */
  record(entry: Omit<AuditEntry, "id" | "ts"> & { ts?: string }): void {
    const ts = entry.ts ?? new Date().toISOString();
    this.db.prepare(`
      INSERT INTO audit_entries
        (ts, action, tool, decision, rule_matched, context_snapshot, prompted, infinite_mode, eval_ms, session_id)
      VALUES
        ($ts, $action, $tool, $decision, $rule_matched, $context_snapshot, $prompted, $infinite_mode, $eval_ms, $session_id)
    `).run({
      $ts: ts,
      $action: entry.action,
      $tool: entry.tool,
      $decision: entry.decision,
      $rule_matched: entry.rule_matched ?? null,
      $context_snapshot: this._sanitiseContext(entry.context_snapshot),
      $prompted: entry.prompted ? 1 : 0,
      $infinite_mode: entry.infinite_mode ? 1 : 0,
      $eval_ms: entry.eval_ms,
      $session_id: entry.session_id ?? null,
    });
  }

  /**
   * Convenience helper: record a policy engine evaluation result.
   */
  recordPolicyCheck(opts: {
    action: PolicyActionType | string;
    context: PolicyContext;
    decision: AuditDecision;
    ruleMatched?: string;
    evalMs?: number;
    sessionId?: string;
    infiniteMode?: boolean;
  }): void {
    const tool = opts.context.command
      ? String(opts.context.command).split(" ")[0]
      : opts.context.path
      ? "file"
      : opts.action;

    this.record({
      action: opts.action,
      tool,
      decision: opts.decision,
      rule_matched: opts.ruleMatched ?? null,
      context_snapshot: JSON.stringify(opts.context),
      prompted: opts.decision === "require_approval",
      infinite_mode: opts.infiniteMode ?? false,
      eval_ms: opts.evalMs ?? 0,
      session_id: opts.sessionId ?? null,
    });
  }

  /**
   * Query audit entries with optional filters. Returns entries sorted by ts DESC.
   */
  query(filters: QueryFilters = {}): AuditEntry[] {
    const conditions: string[] = [];
    const params: Record<string, string | number> = {};
    if (filters.tool) { conditions.push("tool = $tool"); params.$tool = filters.tool; }
    if (filters.decision) { conditions.push("decision = $decision"); params.$decision = filters.decision; }
    if (filters.since !== undefined) { conditions.push("ts >= $since"); params.$since = new Date(filters.since).toISOString(); }
    if (filters.until !== undefined) { conditions.push("ts <= $until"); params.$until = new Date(filters.until).toISOString(); }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filters.limit ?? 500;
    const rows = this.db
      .query<AuditEntry, typeof params>(`SELECT * FROM audit_entries ${where} ORDER BY ts DESC LIMIT ${limit}`)
      .all(params);
    return rows.map((row) => this._deserialiseRow(row));
  }

  /** Query entries by tool name. */
  queryByTool(tool: string, limit = 200): AuditEntry[] {
    return this.query({ tool, limit });
  }

  /** Query entries by decision outcome. */
  queryByDecision(decision: AuditDecision, limit = 200): AuditEntry[] {
    return this.query({ decision, limit });
  }

  /** Query entries within a time window. */
  queryByTime(since: Date, until?: Date, limit = 500): AuditEntry[] {
    return this.query({ since: since.getTime(), until: until?.getTime(), limit });
  }

  /** Get total count of entries, optionally filtered. */
  count(filters: Omit<QueryFilters, "limit"> = {}): number {
    const conditions: string[] = [];
    const params: Record<string, string | number> = {};
    if (filters.tool) { conditions.push("tool = $tool"); params.$tool = filters.tool; }
    if (filters.decision) { conditions.push("decision = $decision"); params.$decision = filters.decision; }
    if (filters.since !== undefined) { conditions.push("ts >= $since"); params.$since = new Date(filters.since).toISOString(); }
    if (filters.until !== undefined) { conditions.push("ts <= $until"); params.$until = new Date(filters.until).toISOString(); }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const row = this.db
      .query<{ n: number }, typeof params>(`SELECT COUNT(*) as n FROM audit_entries ${where}`)
      .get(params);
    return row?.n ?? 0;
  }

  /**
   * Detect tools with elevated escalation rates (require_approval + denied) in a time window.
   * Returns sorted by escalation_count DESC.
   */
  escalationPatterns(opts: { since?: Date; minCount?: number } = {}): EscalationPattern[] {
    const since = opts.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
    const minCount = opts.minCount ?? 2;

    const rows = this.db
      .query<
        { tool: string; decision: string; ts: string },
        { $since: string; $d1: string; $d2: string }
      >(
        `SELECT tool, decision, ts FROM audit_entries
         WHERE ts >= $since AND decision IN ($d1, $d2)
         ORDER BY ts DESC`
      )
      .all({ $since: since.toISOString(), $d1: "require_approval", $d2: "denied" });

    const byTool = new Map<string, { decisions: Record<string, number>; last: string }>();
    for (const row of rows) {
      let entry = byTool.get(row.tool);
      if (!entry) { entry = { decisions: {}, last: row.ts }; byTool.set(row.tool, entry); }
      entry.decisions[row.decision] = (entry.decisions[row.decision] ?? 0) + 1;
      if (row.ts > entry.last) entry.last = row.ts;
    }

    const patterns: EscalationPattern[] = [];
    for (const [tool, data] of byTool) {
      const total = Object.values(data.decisions).reduce((a, b) => a + b, 0);
      if (total >= minCount) {
        patterns.push({ tool, escalation_count: total, last_escalation: data.last, decisions: data.decisions });
      }
    }
    return patterns.sort((a, b) => b.escalation_count - a.escalation_count);
  }

  /**
   * Generate a full audit report for a time window (default: last 7 days).
   */
  exportReport(opts: {
    since?: Date;
    until?: Date;
    includeEntries?: boolean;
    entryLimit?: number;
  } = {}): AuditReport {
    const since = opts.since ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const until = opts.until ?? new Date();
    const sinceIso = since.toISOString();
    const untilIso = until.toISOString();

    const total = this.db
      .query<{ n: number }, { $s: string; $u: string }>(
        "SELECT COUNT(*) as n FROM audit_entries WHERE ts >= $s AND ts <= $u"
      ).get({ $s: sinceIso, $u: untilIso });

    const decisionRows = this.db
      .query<{ decision: string; n: number }, { $s: string; $u: string }>(
        "SELECT decision, COUNT(*) as n FROM audit_entries WHERE ts >= $s AND ts <= $u GROUP BY decision"
      ).all({ $s: sinceIso, $u: untilIso });
    const by_decision: Record<string, number> = {};
    for (const row of decisionRows) by_decision[row.decision] = row.n;

    const toolRows = this.db
      .query<{ tool: string; n: number }, { $s: string; $u: string }>(
        "SELECT tool, COUNT(*) as n FROM audit_entries WHERE ts >= $s AND ts <= $u GROUP BY tool ORDER BY n DESC"
      ).all({ $s: sinceIso, $u: untilIso });
    const by_tool: Record<string, number> = {};
    for (const row of toolRows) by_tool[row.tool] = row.n;

    const blockedRows = this.db
      .query<{ tool: string; n: number }, { $s: string; $u: string }>(
        "SELECT tool, COUNT(*) as n FROM audit_entries WHERE ts >= $s AND ts <= $u AND decision = 'block' GROUP BY tool ORDER BY n DESC LIMIT 10"
      ).all({ $s: sinceIso, $u: untilIso });

    const infiniteRow = this.db
      .query<{ n: number }, { $s: string; $u: string }>(
        "SELECT COUNT(*) as n FROM audit_entries WHERE ts >= $s AND ts <= $u AND infinite_mode = 1"
      ).get({ $s: sinceIso, $u: untilIso });

    const promptedRow = this.db
      .query<{ n: number }, { $s: string; $u: string }>(
        "SELECT COUNT(*) as n FROM audit_entries WHERE ts >= $s AND ts <= $u AND prompted = 1"
      ).get({ $s: sinceIso, $u: untilIso });

    const avgRow = this.db
      .query<{ avg: number | null }, { $s: string; $u: string }>(
        "SELECT AVG(eval_ms) as avg FROM audit_entries WHERE ts >= $s AND ts <= $u"
      ).get({ $s: sinceIso, $u: untilIso });

    return {
      generated_at: new Date().toISOString(),
      window_start: sinceIso,
      window_end: untilIso,
      total_checks: total?.n ?? 0,
      by_decision: by_decision as Record<AuditDecision, number>,
      by_tool,
      escalation_patterns: this.escalationPatterns({ since, minCount: 1 }),
      top_blocked_tools: blockedRows.map((r) => ({ tool: r.tool, count: r.n })),
      infinite_mode_checks: infiniteRow?.n ?? 0,
      prompted_checks: promptedRow?.n ?? 0,
      avg_eval_ms: Math.round((avgRow?.avg ?? 0) * 100) / 100,
      entries: opts.includeEntries !== false
        ? this.query({ since: since.getTime(), until: until.getTime(), limit: opts.entryLimit ?? 1000 })
        : [],
    };
  }

  /**
   * Export report as a formatted Markdown string.
   */
  exportMarkdown(opts: Parameters<AuditLog["exportReport"]>[0] = {}): string {
    const r = this.exportReport({ ...opts, includeEntries: true, entryLimit: 200 });
    const lines: string[] = [
      `# NemoClaw Permission Audit Report`,
      ``,
      `**Generated:** ${r.generated_at}`,
      `**Window:** ${r.window_start} - ${r.window_end}`,
      ``,
      `## Summary`,
      ``,
      `| Metric | Value |`,
      `|--------|-------|`,
      `| Total checks | ${r.total_checks} |`,
      `| Infinite-mode checks | ${r.infinite_mode_checks} |`,
      `| User-prompted checks | ${r.prompted_checks} |`,
      `| Avg eval time | ${r.avg_eval_ms}ms |`,
      ``,
      `## Decisions`,
      ``,
      `| Decision | Count |`,
      `|----------|-------|`,
      ...Object.entries(r.by_decision).map(([d, n]) => `| ${d} | ${n} |`),
      ``,
      `## By Tool`,
      ``,
      `| Tool | Checks |`,
      `|------|--------|`,
      ...Object.entries(r.by_tool).map(([t, n]) => `| ${t} | ${n} |`),
      ``,
      `## Top Blocked Tools`,
      ``,
    ];
    if (r.top_blocked_tools.length === 0) {
      lines.push(`_None in window_`);
    } else {
      lines.push(`| Tool | Blocks |`, `|------|--------|`);
      for (const t of r.top_blocked_tools) lines.push(`| ${t.tool} | ${t.count} |`);
    }
    lines.push(``, `## Escalation Patterns`, ``);
    if (r.escalation_patterns.length === 0) {
      lines.push(`_No escalation patterns detected_`);
    } else {
      lines.push(`| Tool | Escalations | Last | Breakdown |`, `|------|-------------|------|-----------|`);
      for (const p of r.escalation_patterns) {
        lines.push(`| ${p.tool} | ${p.escalation_count} | ${p.last_escalation} | ${JSON.stringify(p.decisions)} |`);
      }
    }
    lines.push(``, `## Recent Entries (last ${r.entries.length})`, ``, `| Time | Action | Tool | Decision | Rule | Infinite |`, `|------|--------|------|----------|------|----------|`);
    for (const e of r.entries.slice(0, 100)) {
      lines.push(`| ${e.ts} | ${e.action} | ${e.tool} | ${e.decision} | ${e.rule_matched ?? "-"} | ${e.infinite_mode ? "yes" : "no"} |`);
    }
    return lines.join("\n");
  }

  /** Delete entries older than N days (default 90). Returns deleted row count. */
  prune(days = 90): number {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    return this.db.prepare("DELETE FROM audit_entries WHERE ts < $cutoff").run({ $cutoff: cutoff }).changes;
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }

  private _sanitiseContext(raw: string): string {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(raw); } catch { return "{}"; }
    for (const field of REDACTED_FIELDS) {
      for (const key of Object.keys(parsed)) {
        if (key.toLowerCase().includes(field)) parsed[key] = "[REDACTED]";
      }
    }
    if (typeof parsed.content === "string" && parsed.content.length > 200) {
      parsed.content = parsed.content.slice(0, 200) + "...[truncated]";
    }
    const serialised = JSON.stringify(parsed);
    return serialised.length > MAX_CONTEXT_BYTES
      ? serialised.slice(0, MAX_CONTEXT_BYTES) + '..."[truncated]}'
      : serialised;
  }

  private _deserialiseRow(row: AuditEntry): AuditEntry {
    return { ...row, prompted: Boolean(row.prompted), infinite_mode: Boolean(row.infinite_mode) };
  }
}

// ============================================
// Singleton
// ============================================

let _instance: AuditLog | null = null;

export function getAuditLog(dbPath?: string): AuditLog {
  if (!_instance) _instance = new AuditLog(dbPath);
  return _instance;
}

export function resetAuditLog(): void {
  _instance?.close();
  _instance = null;
}
