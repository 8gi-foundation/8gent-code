/**
 * AST-First Code Exploration Efficiency Report
 *
 * Reads metrics from ~/.claude/research/ast-efficiency-metrics.jsonl,
 * calculates token savings, cache hit rates, and identifies files
 * that would benefit most from AST indexing.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ============================================
// Types
// ============================================

interface MetricEntry {
  session_id: string;
  timestamp: string;
  tool_used: string;
  file_path: string;
  file_size_bytes: number;
  estimated_tokens: number;
  should_use_ast: boolean;
  savings_potential: number;
  ast_alternative?: string;
}

export interface WeeklyReport {
  period: { start: string; end: string };
  totalReads: number;
  astEligibleReads: number;
  astEligiblePercent: number;
  totalTokensConsumed: number;
  totalTokensSaveable: number;
  savingsPercent: number;
  topWastefulFiles: FileWaste[];
  mostQueriedFiles: FileFrequency[];
  sessionBreakdown: SessionSummary[];
  recommendations: string[];
}

interface FileWaste {
  filePath: string;
  shortPath: string;
  reads: number;
  totalTokens: number;
  saveable: number;
}

interface FileFrequency {
  filePath: string;
  shortPath: string;
  reads: number;
}

interface SessionSummary {
  sessionId: string;
  reads: number;
  astMisses: number;
  tokensSaved: number;
}

// ============================================
// Constants
// ============================================

const METRICS_PATH = path.join(os.homedir(), ".claude/research/ast-efficiency-metrics.jsonl");
const MS_PER_DAY = 86_400_000;

// ============================================
// Core
// ============================================

function loadMetrics(daysBack: number = 7): MetricEntry[] {
  if (!fs.existsSync(METRICS_PATH)) return [];

  const cutoff = new Date(Date.now() - daysBack * MS_PER_DAY).toISOString();
  const lines = fs.readFileSync(METRICS_PATH, "utf-8").split("\n").filter(Boolean);
  const entries: MetricEntry[] = [];

  for (const line of lines) {
    try {
      const entry: MetricEntry = JSON.parse(line);
      if (entry.timestamp >= cutoff) entries.push(entry);
    } catch {
      // skip malformed lines
    }
  }

  return entries;
}

function shortenPath(filePath: string): string {
  const home = os.homedir();
  return filePath.startsWith(home) ? "~" + filePath.slice(home.length) : filePath;
}

export function generateReport(daysBack: number = 7): WeeklyReport {
  const entries = loadMetrics(daysBack);
  if (entries.length === 0) {
    return emptyReport(daysBack);
  }

  const timestamps = entries.map(e => e.timestamp).sort();
  const period = { start: timestamps[0], end: timestamps[timestamps.length - 1] };

  const astEligible = entries.filter(e => e.should_use_ast);
  const totalTokensConsumed = entries.reduce((s, e) => s + e.estimated_tokens, 0);
  const totalTokensSaveable = entries.reduce((s, e) => s + e.savings_potential, 0);

  // File-level aggregation for waste ranking
  const fileMap = new Map<string, { reads: number; tokens: number; saveable: number }>();
  for (const e of entries) {
    const prev = fileMap.get(e.file_path) ?? { reads: 0, tokens: 0, saveable: 0 };
    prev.reads++;
    prev.tokens += e.estimated_tokens;
    prev.saveable += e.savings_potential;
    fileMap.set(e.file_path, prev);
  }

  const topWastefulFiles: FileWaste[] = [...fileMap.entries()]
    .filter(([, v]) => v.saveable > 0)
    .sort((a, b) => b[1].saveable - a[1].saveable)
    .slice(0, 10)
    .map(([fp, v]) => ({
      filePath: fp,
      shortPath: shortenPath(fp),
      reads: v.reads,
      totalTokens: v.tokens,
      saveable: v.saveable,
    }));

  const mostQueriedFiles: FileFrequency[] = [...fileMap.entries()]
    .sort((a, b) => b[1].reads - a[1].reads)
    .slice(0, 10)
    .map(([fp, v]) => ({ filePath: fp, shortPath: shortenPath(fp), reads: v.reads }));

  // Session breakdown
  const sessionMap = new Map<string, { reads: number; astMisses: number; saved: number }>();
  for (const e of entries) {
    const key = e.session_id ?? "unknown";
    const prev = sessionMap.get(key) ?? { reads: 0, astMisses: 0, saved: 0 };
    prev.reads++;
    if (e.should_use_ast) prev.astMisses++;
    prev.saved += e.savings_potential;
    sessionMap.set(key, prev);
  }

  const sessionBreakdown: SessionSummary[] = [...sessionMap.entries()]
    .sort((a, b) => b[1].saved - a[1].saved)
    .slice(0, 10)
    .map(([id, v]) => ({
      sessionId: id.slice(0, 8),
      reads: v.reads,
      astMisses: v.astMisses,
      tokensSaved: v.saved,
    }));

  // Recommendations
  const recommendations: string[] = [];
  const savingsPercent = totalTokensConsumed > 0
    ? Math.round((totalTokensSaveable / totalTokensConsumed) * 100)
    : 0;

  if (savingsPercent > 30) {
    recommendations.push(
      `${savingsPercent}% of tokens are wasted on full-file reads. Use AST outline + symbol fetch.`
    );
  }
  if (topWastefulFiles.length > 0) {
    const worst = topWastefulFiles[0];
    recommendations.push(
      `Index "${worst.shortPath}" first - it wastes ${worst.saveable.toLocaleString()} tokens across ${worst.reads} reads.`
    );
  }
  const repeatedFiles = mostQueriedFiles.filter(f => f.reads >= 3);
  if (repeatedFiles.length > 0) {
    recommendations.push(
      `${repeatedFiles.length} files read 3+ times. Keep these indexed to avoid repeated full reads.`
    );
  }
  if (astEligible.length === 0) {
    recommendations.push("All reads were config/small files - AST protocol is being followed well.");
  }

  return {
    period,
    totalReads: entries.length,
    astEligibleReads: astEligible.length,
    astEligiblePercent: Math.round((astEligible.length / entries.length) * 100),
    totalTokensConsumed,
    totalTokensSaveable,
    savingsPercent,
    topWastefulFiles,
    mostQueriedFiles,
    sessionBreakdown,
    recommendations,
  };
}

function emptyReport(daysBack: number): WeeklyReport {
  const now = new Date();
  return {
    period: {
      start: new Date(now.getTime() - daysBack * MS_PER_DAY).toISOString(),
      end: now.toISOString(),
    },
    totalReads: 0, astEligibleReads: 0, astEligiblePercent: 0,
    totalTokensConsumed: 0, totalTokensSaveable: 0, savingsPercent: 0,
    topWastefulFiles: [], mostQueriedFiles: [], sessionBreakdown: [],
    recommendations: ["No metrics found. Ensure the PreToolUse hook is logging to ast-efficiency-metrics.jsonl."],
  };
}

export function formatReport(report: WeeklyReport): string {
  const lines: string[] = [
    "# AST-First Efficiency Report",
    "",
    `Period: ${report.period.start.slice(0, 10)} to ${report.period.end.slice(0, 10)}`,
    "",
    "## Summary",
    "",
    `- Total file reads: ${report.totalReads}`,
    `- AST-eligible reads (wasted): ${report.astEligibleReads} (${report.astEligiblePercent}%)`,
    `- Total tokens consumed: ${report.totalTokensConsumed.toLocaleString()}`,
    `- Tokens saveable via AST: ${report.totalTokensSaveable.toLocaleString()} (${report.savingsPercent}%)`,
    "",
  ];

  if (report.topWastefulFiles.length > 0) {
    lines.push("## Top Wasteful Files (index these first)", "");
    lines.push("| File | Reads | Tokens Wasted |");
    lines.push("|------|-------|---------------|");
    for (const f of report.topWastefulFiles) {
      lines.push(`| ${f.shortPath} | ${f.reads} | ${f.saveable.toLocaleString()} |`);
    }
    lines.push("");
  }

  if (report.mostQueriedFiles.length > 0) {
    lines.push("## Most Queried Files", "");
    lines.push("| File | Reads |");
    lines.push("|------|-------|");
    for (const f of report.mostQueriedFiles) {
      lines.push(`| ${f.shortPath} | ${f.reads} |`);
    }
    lines.push("");
  }

  if (report.sessionBreakdown.length > 0) {
    lines.push("## Session Breakdown", "");
    lines.push("| Session | Reads | AST Misses | Tokens Saved |");
    lines.push("|---------|-------|------------|--------------|");
    for (const s of report.sessionBreakdown) {
      lines.push(`| ${s.sessionId} | ${s.reads} | ${s.astMisses} | ${s.tokensSaved.toLocaleString()} |`);
    }
    lines.push("");
  }

  if (report.recommendations.length > 0) {
    lines.push("## Recommendations", "");
    for (const r of report.recommendations) {
      lines.push(`- ${r}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ============================================
// CLI entry point
// ============================================

if (import.meta.main) {
  const days = parseInt(process.argv[2] ?? "7", 10);
  const report = generateReport(days);
  console.log(formatReport(report));
}
