/**
 * Activity logger — daily markdown log files for observability.
 */

import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ActivityType = "task" | "error" | "tool_call" | "completion";

export interface ActivityEntry {
  timestamp: string; // ISO-8601
  type: ActivityType;
  summary: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOG_DIR_DEFAULT = `${homedir()}/.8gent/logs`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dateStr(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function formatEntry(entry: ActivityEntry): string {
  const time = new Date(entry.timestamp).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const meta = entry.metadata
    ? ` | ${JSON.stringify(entry.metadata)}`
    : "";
  return `- **${time}** \`[${entry.type}]\` ${entry.summary}${meta}`;
}

function parseEntry(line: string): ActivityEntry | null {
  // Parse: - **HH:MM:SS** `[type]` summary | metadata
  const match = line.match(
    /^- \*\*(.+?)\*\* `\[(.+?)\]` (.+?)(?:\s*\|\s*(.+))?$/
  );
  if (!match) return null;

  const [, timeStr, type, summary, metaStr] = match;

  // Reconstruct a full ISO timestamp using today's date + parsed time
  const now = new Date();
  const [h, m, s] = (timeStr ?? "00:00:00").split(":").map(Number);
  now.setHours(h ?? 0, m ?? 0, s ?? 0, 0);

  let metadata: Record<string, unknown> | undefined;
  if (metaStr) {
    try {
      metadata = JSON.parse(metaStr);
    } catch {
      metadata = { raw: metaStr };
    }
  }

  return {
    timestamp: now.toISOString(),
    type: type as ActivityType,
    summary: summary.trim(),
    metadata,
  };
}

// ---------------------------------------------------------------------------
// ActivityLogger
// ---------------------------------------------------------------------------

export class ActivityLogger {
  private logDir: string;

  constructor(logDir?: string) {
    this.logDir = logDir ?? LOG_DIR_DEFAULT;
    if (!existsSync(this.logDir)) {
      mkdirSync(this.logDir, { recursive: true });
    }
  }

  private pathForDate(date: string): string {
    return join(this.logDir, `${date}.md`);
  }

  /** Append an activity entry to today's log. */
  log(entry: ActivityEntry): void {
    const date = dateStr(new Date(entry.timestamp));
    const filePath = this.pathForDate(date);

    // Create file with header if it doesn't exist
    if (!existsSync(filePath)) {
      writeFileSync(filePath, `# Activity Log — ${date}\n\n`, "utf-8");
    }

    appendFileSync(filePath, formatEntry(entry) + "\n", "utf-8");
  }

  /** Convenience: log with auto-timestamp. */
  logNow(
    type: ActivityType,
    summary: string,
    metadata?: Record<string, unknown>
  ): void {
    this.log({
      timestamp: new Date().toISOString(),
      type,
      summary,
      metadata,
    });
  }

  /** Get all entries logged today. */
  getToday(): ActivityEntry[] {
    return this.getEntriesForDate(dateStr());
  }

  /** Get entries from the last N days (default 7). */
  getRecent(days = 7): ActivityEntry[] {
    const entries: ActivityEntry[] = [];
    const now = new Date();

    for (let i = 0; i < days; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      entries.push(...this.getEntriesForDate(dateStr(d)));
    }

    return entries;
  }

  /** Parse entries from a specific date's log file. */
  private getEntriesForDate(date: string): ActivityEntry[] {
    const filePath = this.pathForDate(date);
    if (!existsSync(filePath)) return [];

    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const entries: ActivityEntry[] = [];

    for (const line of lines) {
      const entry = parseEntry(line.trim());
      if (entry) entries.push(entry);
    }

    return entries;
  }

  /** List available log dates. */
  listDates(): string[] {
    if (!existsSync(this.logDir)) return [];
    return readdirSync(this.logDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(".md", ""))
      .sort()
      .reverse();
  }
}
