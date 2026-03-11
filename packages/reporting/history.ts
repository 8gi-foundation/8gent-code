/**
 * 8gent Code - Report History
 *
 * Manages report storage, retrieval, and listing.
 * Provides /reports and /report <id> commands.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  type CompletionReport,
  type StoredReport,
  type ReportQuery,
  type ReportListItem,
} from "./types";
import {
  colors,
  colorize,
  bold,
  muted,
  success,
  warning,
  error,
  info,
  divider,
  table,
  statusIcon,
  formatDuration,
  boxChars,
} from "./formatter";
import { CompletionReporter } from "./completion";

// ============================================
// Report History Manager
// ============================================

export class ReportHistory {
  private reportsDir: string;
  private reporter: CompletionReporter;

  constructor(reportsDir?: string) {
    this.reportsDir = reportsDir || path.join(os.homedir(), ".8gent", "reports");
    this.reporter = new CompletionReporter(this.reportsDir);
    this.ensureDir();
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.reportsDir)) {
      fs.mkdirSync(this.reportsDir, { recursive: true });
    }
  }

  // ============================================
  // List Reports
  // ============================================

  listReports(query: ReportQuery = {}): ReportListItem[] {
    const {
      limit = 20,
      offset = 0,
      status,
      after,
      before,
      workingDirectory,
    } = query;

    const files = fs.readdirSync(this.reportsDir)
      .filter(f => f.endsWith(".json"))
      .sort((a, b) => b.localeCompare(a)); // Newest first

    const items: ReportListItem[] = [];
    let skipped = 0;

    for (const file of files) {
      if (items.length >= limit) break;

      try {
        const filepath = path.join(this.reportsDir, file);
        const content = fs.readFileSync(filepath, "utf-8");
        const report = JSON.parse(content) as StoredReport;

        // Convert dates
        const completedAt = new Date(report.completedAt);

        // Apply filters
        if (status && report.status !== status) continue;
        if (after && completedAt < after) continue;
        if (before && completedAt > before) continue;
        if (workingDirectory && report.workingDirectory !== workingDirectory) continue;

        // Apply offset
        if (skipped < offset) {
          skipped++;
          continue;
        }

        items.push({
          id: report.id,
          summary: report.summary,
          status: report.status,
          duration: report.duration,
          completedAt,
          filesChanged: report.filesCreated.length + report.filesModified.length,
        });
      } catch {
        // Skip invalid files
      }
    }

    return items;
  }

  // ============================================
  // Get Single Report
  // ============================================

  getReport(reportId: string): CompletionReport | null {
    return this.reporter.loadReport(reportId);
  }

  // ============================================
  // Delete Report
  // ============================================

  deleteReport(reportId: string): boolean {
    return this.reporter.deleteReport(reportId);
  }

  // ============================================
  // Get Stats
  // ============================================

  getStats(): ReportStats {
    const files = fs.readdirSync(this.reportsDir)
      .filter(f => f.endsWith(".json"));

    const stats: ReportStats = {
      total: 0,
      success: 0,
      partial: 0,
      failed: 0,
      totalDuration: 0,
      totalFilesCreated: 0,
      totalFilesModified: 0,
      totalToolsUsed: 0,
    };

    for (const file of files) {
      try {
        const filepath = path.join(this.reportsDir, file);
        const content = fs.readFileSync(filepath, "utf-8");
        const report = JSON.parse(content) as StoredReport;

        stats.total++;
        stats[report.status]++;
        stats.totalDuration += report.durationMs;
        stats.totalFilesCreated += report.filesCreated.length;
        stats.totalFilesModified += report.filesModified.length;
        stats.totalToolsUsed += report.toolsUsed;
      } catch {
        // Skip invalid files
      }
    }

    return stats;
  }

  // ============================================
  // Format for Terminal
  // ============================================

  formatReportList(items: ReportListItem[]): string {
    if (items.length === 0) {
      return muted("No reports found. Complete a task to generate a report.");
    }

    const lines: string[] = [];

    lines.push(bold(info("Recent Reports")));
    lines.push("");

    for (const item of items) {
      const statusStr = item.status === "success"
        ? success(boxChars.checkmark)
        : item.status === "partial"
        ? warning("~")
        : error(boxChars.crossmark);

      const timeAgo = this.formatTimeAgo(item.completedAt);
      const idShort = item.id.slice(0, 12);

      lines.push(`${statusStr} ${muted(idShort)} ${item.summary.slice(0, 40)}${item.summary.length > 40 ? "..." : ""}`);
      lines.push(`  ${muted(`${item.duration} | ${item.filesChanged} files | ${timeAgo}`)}`);
      lines.push("");
    }

    lines.push(muted(`Use /report <id> to view details`));

    return lines.join("\n");
  }

  formatReportDetail(report: CompletionReport): string {
    return this.reporter.formatForTerminal(report);
  }

  formatStats(stats: ReportStats): string {
    const lines: string[] = [];

    lines.push(bold(info("Report Statistics")));
    lines.push("");

    const rows = [
      ["Total", String(stats.total)],
      ["Success", success(String(stats.success))],
      ["Partial", warning(String(stats.partial))],
      ["Failed", error(String(stats.failed))],
      ["Avg Duration", formatDuration(stats.total > 0 ? Math.round(stats.totalDuration / stats.total) : 0)],
      ["Total Files Created", String(stats.totalFilesCreated)],
      ["Total Files Modified", String(stats.totalFilesModified)],
      ["Total Tools Used", String(stats.totalToolsUsed)],
    ];

    for (const [key, value] of rows) {
      lines.push(`  ${muted(key.padEnd(20))} ${value}`);
    }

    return lines.join("\n");
  }

  private formatTimeAgo(date: Date): string {
    const now = Date.now();
    const diff = now - date.getTime();

    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return "just now";

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;

    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;

    const weeks = Math.floor(days / 7);
    if (weeks < 4) return `${weeks}w ago`;

    const months = Math.floor(days / 30);
    return `${months}mo ago`;
  }

  // ============================================
  // Cleanup Old Reports
  // ============================================

  cleanup(options: { maxAge?: number; maxCount?: number } = {}): number {
    const { maxAge = 30 * 24 * 60 * 60 * 1000, maxCount = 100 } = options; // 30 days, 100 reports

    const files = fs.readdirSync(this.reportsDir)
      .filter(f => f.endsWith(".json"))
      .sort((a, b) => b.localeCompare(a)); // Newest first

    let deleted = 0;
    const now = Date.now();

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const filepath = path.join(this.reportsDir, file);

      try {
        const stat = fs.statSync(filepath);
        const age = now - stat.mtime.getTime();

        // Delete if too old or exceeds max count
        if (age > maxAge || i >= maxCount) {
          fs.unlinkSync(filepath);
          deleted++;
        }
      } catch {
        // Skip if can't access
      }
    }

    return deleted;
  }

  getReportsDir(): string {
    return this.reportsDir;
  }
}

// ============================================
// Types
// ============================================

export interface ReportStats {
  total: number;
  success: number;
  partial: number;
  failed: number;
  totalDuration: number;
  totalFilesCreated: number;
  totalFilesModified: number;
  totalToolsUsed: number;
}

// ============================================
// Command Handlers
// ============================================

export function handleReportsCommand(history: ReportHistory, args: string[]): string {
  const showStats = args.includes("--stats") || args.includes("-s");
  const statusFilter = args.find(a => a.startsWith("--status="))?.split("=")[1] as CompletionReport["status"] | undefined;
  const limitArg = args.find(a => a.startsWith("--limit="))?.split("=")[1];
  const limit = limitArg ? parseInt(limitArg, 10) : 10;

  if (showStats) {
    const stats = history.getStats();
    return history.formatStats(stats);
  }

  const items = history.listReports({ limit, status: statusFilter });
  return history.formatReportList(items);
}

export function handleReportCommand(history: ReportHistory, reportId: string): string {
  // Support partial ID matching
  if (reportId.length < 36) {
    const items = history.listReports({ limit: 100 });
    const match = items.find(item => item.id.startsWith(reportId));
    if (match) {
      reportId = match.id;
    }
  }

  const report = history.getReport(reportId);

  if (!report) {
    return error(`Report not found: ${reportId}`);
  }

  return history.formatReportDetail(report);
}

// ============================================
// Exports
// ============================================

// Singleton instance
let defaultHistory: ReportHistory | null = null;

export function getReportHistory(): ReportHistory {
  if (!defaultHistory) {
    defaultHistory = new ReportHistory();
  }
  return defaultHistory;
}

export function createHistory(reportsDir?: string): ReportHistory {
  return new ReportHistory(reportsDir);
}
