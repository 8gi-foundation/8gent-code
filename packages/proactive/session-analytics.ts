/**
 * Session Analytics - per-session and cross-session metrics from ~/.8gent/ event logs
 *
 * Reads two data sources:
 *   1. ~/.8gent/runs.jsonl - one line per agent turn (tokens, tools, duration, status)
 *   2. ~/.8gent/sessions/*.jsonl - granular event logs (tool_call, step_end, etc.)
 *
 * Outputs weekly analytics: tool usage, session durations, success rates, peak hours,
 * and prompt-to-completion speed patterns.
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";

// ============================================
// Types
// ============================================

export interface RunEntry {
  ts: string;
  status: "ok" | "fail";
  model: string;
  dur: number;
  tokens: number;
  cost: number | null;
  tools: number;
  created: string[];
  modified: string[];
  session: string;
  cwd: string;
  prompt: string;
  error?: string;
}

export interface SessionMetrics {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  durationSec: number;
  totalTokens: number;
  toolCalls: number;
  turnCount: number;
  successRate: number;
  model: string;
  filesCreated: number;
  filesModified: number;
  prompts: string[];
}

export interface AggregateReport {
  generatedAt: string;
  periodDays: number;
  totalSessions: number;
  totalTokens: number;
  totalToolCalls: number;
  avgSessionDurationSec: number;
  avgTokensPerSession: number;
  avgToolCallsPerSession: number;
  overallSuccessRate: number;
  toolUsageRanking: { tool: string; count: number }[];
  peakHours: { hour: number; sessionCount: number }[];
  modelUsage: { model: string; sessions: number; tokens: number }[];
  fastestPromptPatterns: { pattern: string; avgDurationSec: number; count: number }[];
  sessions: SessionMetrics[];
}

// ============================================
// Data Loading
// ============================================

const DATA_DIR = resolve(homedir(), ".8gent");
const RUNS_FILE = join(DATA_DIR, "runs.jsonl");
const SESSIONS_DIR = join(DATA_DIR, "sessions");

function loadRuns(): RunEntry[] {
  if (!existsSync(RUNS_FILE)) return [];
  const lines = readFileSync(RUNS_FILE, "utf-8").split("\n").filter(Boolean);
  const entries: RunEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

function loadSessionToolCalls(sessionId: string): { tool: string; count: number }[] {
  const file = join(SESSIONS_DIR, `${sessionId}.jsonl`);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
  const counts = new Map<string, number>();
  for (const line of lines) {
    try {
      const evt = JSON.parse(line);
      if (evt.type === "tool_call" && evt.toolCall?.name) {
        counts.set(evt.toolCall.name, (counts.get(evt.toolCall.name) || 0) + 1);
      }
    } catch {
      // skip
    }
  }
  return [...counts.entries()].map(([tool, count]) => ({ tool, count }));
}

// ============================================
// Per-Session Aggregation
// ============================================

function buildSessionMetrics(runs: RunEntry[]): SessionMetrics[] {
  const grouped = new Map<string, RunEntry[]>();
  for (const r of runs) {
    const list = grouped.get(r.session) || [];
    list.push(r);
    grouped.set(r.session, list);
  }

  const sessions: SessionMetrics[] = [];
  for (const [sessionId, turns] of grouped) {
    const sorted = turns.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const start = new Date(first.ts);
    const end = new Date(last.ts);
    const durationSec = Math.max(1, Math.round((end.getTime() - start.getTime()) / 1000) + (last.dur || 0));

    const okCount = sorted.filter((t) => t.status === "ok").length;
    sessions.push({
      sessionId,
      startedAt: first.ts,
      endedAt: last.ts,
      durationSec,
      totalTokens: sorted.reduce((s, t) => s + (t.tokens || 0), 0),
      toolCalls: sorted.reduce((s, t) => s + (t.tools || 0), 0),
      turnCount: sorted.length,
      successRate: sorted.length > 0 ? okCount / sorted.length : 0,
      model: first.model,
      filesCreated: sorted.reduce((s, t) => s + t.created.length, 0),
      filesModified: sorted.reduce((s, t) => s + t.modified.length, 0),
      prompts: sorted.map((t) => t.prompt),
    });
  }
  return sessions.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
}

// ============================================
// Cross-Session Aggregation
// ============================================

function classifyPrompt(prompt: string): string {
  const p = prompt.toLowerCase();
  if (p.match(/\bfix\b|bug|error|broken/)) return "fix";
  if (p.match(/\bcreate\b|build|make|add/)) return "create";
  if (p.match(/\breview\b|check|analyze/)) return "review";
  if (p.match(/\brefactor\b|clean|reorganize/)) return "refactor";
  if (p.match(/\btest\b|benchmark|run/)) return "test";
  if (p.length < 15) return "short-command";
  return "general";
}

export function generateReport(periodDays: number = 7): AggregateReport {
  const allRuns = loadRuns();
  const cutoff = Date.now() - periodDays * 86_400_000;
  const runs = allRuns.filter((r) => new Date(r.ts).getTime() >= cutoff);
  const sessions = buildSessionMetrics(runs);

  // Tool usage from granular session logs
  const toolTotals = new Map<string, number>();
  for (const s of sessions) {
    const tools = loadSessionToolCalls(s.sessionId);
    for (const { tool, count } of tools) {
      toolTotals.set(tool, (toolTotals.get(tool) || 0) + count);
    }
  }
  const toolUsageRanking = [...toolTotals.entries()]
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  // Peak hours
  const hourCounts = new Array(24).fill(0);
  for (const s of sessions) {
    hourCounts[new Date(s.startedAt).getHours()]++;
  }
  const peakHours = hourCounts
    .map((sessionCount, hour) => ({ hour, sessionCount }))
    .filter((h) => h.sessionCount > 0)
    .sort((a, b) => b.sessionCount - a.sessionCount);

  // Model usage
  const modelMap = new Map<string, { sessions: number; tokens: number }>();
  for (const s of sessions) {
    const m = modelMap.get(s.model) || { sessions: 0, tokens: 0 };
    m.sessions++;
    m.tokens += s.totalTokens;
    modelMap.set(s.model, m);
  }
  const modelUsage = [...modelMap.entries()]
    .map(([model, v]) => ({ model, ...v }))
    .sort((a, b) => b.sessions - a.sessions);

  // Fastest prompt patterns - which prompt categories complete fastest
  const patternDurations = new Map<string, { totalSec: number; count: number }>();
  for (const s of sessions) {
    for (const prompt of s.prompts) {
      const pattern = classifyPrompt(prompt);
      const entry = patternDurations.get(pattern) || { totalSec: 0, count: 0 };
      entry.totalSec += s.durationSec / s.turnCount; // approximate per-turn duration
      entry.count++;
      patternDurations.set(pattern, entry);
    }
  }
  const fastestPromptPatterns = [...patternDurations.entries()]
    .map(([pattern, v]) => ({
      pattern,
      avgDurationSec: Math.round(v.totalSec / v.count),
      count: v.count,
    }))
    .sort((a, b) => a.avgDurationSec - b.avgDurationSec);

  const totalTokens = sessions.reduce((s, x) => s + x.totalTokens, 0);
  const totalToolCalls = sessions.reduce((s, x) => s + x.toolCalls, 0);
  const okTurns = runs.filter((r) => r.status === "ok").length;

  return {
    generatedAt: new Date().toISOString(),
    periodDays,
    totalSessions: sessions.length,
    totalTokens,
    totalToolCalls,
    avgSessionDurationSec: sessions.length > 0 ? Math.round(sessions.reduce((s, x) => s + x.durationSec, 0) / sessions.length) : 0,
    avgTokensPerSession: sessions.length > 0 ? Math.round(totalTokens / sessions.length) : 0,
    avgToolCallsPerSession: sessions.length > 0 ? Math.round(totalToolCalls / sessions.length) : 0,
    overallSuccessRate: runs.length > 0 ? Math.round((okTurns / runs.length) * 100) / 100 : 0,
    toolUsageRanking,
    peakHours,
    modelUsage,
    fastestPromptPatterns,
    sessions,
  };
}

// ============================================
// CLI Entry Point
// ============================================

if (import.meta.main) {
  const days = parseInt(process.argv[2] || "7", 10);
  const report = generateReport(days);

  console.log(`\n--- 8gent Session Analytics (last ${days} days) ---\n`);
  console.log(`Sessions: ${report.totalSessions}`);
  console.log(`Total tokens: ${report.totalTokens.toLocaleString()}`);
  console.log(`Total tool calls: ${report.totalToolCalls}`);
  console.log(`Avg session duration: ${report.avgSessionDurationSec}s`);
  console.log(`Avg tokens/session: ${report.avgTokensPerSession.toLocaleString()}`);
  console.log(`Success rate: ${(report.overallSuccessRate * 100).toFixed(0)}%`);

  if (report.toolUsageRanking.length > 0) {
    console.log(`\nTop tools:`);
    for (const t of report.toolUsageRanking.slice(0, 10)) {
      console.log(`  ${t.tool}: ${t.count}`);
    }
  }

  if (report.peakHours.length > 0) {
    console.log(`\nPeak hours:`);
    for (const h of report.peakHours.slice(0, 5)) {
      console.log(`  ${String(h.hour).padStart(2, "0")}:00 - ${h.sessionCount} sessions`);
    }
  }

  if (report.modelUsage.length > 0) {
    console.log(`\nModels used:`);
    for (const m of report.modelUsage) {
      console.log(`  ${m.model}: ${m.sessions} sessions, ${m.tokens.toLocaleString()} tokens`);
    }
  }

  if (report.fastestPromptPatterns.length > 0) {
    console.log(`\nPrompt patterns (fastest first):`);
    for (const p of report.fastestPromptPatterns) {
      console.log(`  ${p.pattern}: avg ${p.avgDurationSec}s (${p.count} prompts)`);
    }
  }

  console.log(`\nReport generated: ${report.generatedAt}`);
}
