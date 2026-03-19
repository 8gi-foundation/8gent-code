/**
 * Feedback loop — tracks task outcomes and surfaces patterns.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Outcome = "accepted" | "rejected" | "modified" | "reverted";

export interface FeedbackEntry {
  taskId: string;
  outcome: Outcome;
  context?: string;
  timestamp: string; // ISO-8601
}

export interface FeedbackPattern {
  pattern: string;
  frequency: number;
  trend: "improving" | "declining" | "stable";
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ENTRIES = 100;
const ANALYSIS_WINDOW = 50;

// ---------------------------------------------------------------------------
// FeedbackCollector
// ---------------------------------------------------------------------------

export class FeedbackCollector {
  private entries: FeedbackEntry[] = [];
  private filePath: string;

  constructor(filePath?: string) {
    this.filePath =
      filePath ?? `${homedir()}/.8gent/feedback.json`;
    this.load();
  }

  // -- persistence ----------------------------------------------------------

  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, "utf-8");
        this.entries = JSON.parse(raw) as FeedbackEntry[];
      }
    } catch {
      this.entries = [];
    }
  }

  private save(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(
      this.filePath,
      JSON.stringify(this.entries, null, 2),
      "utf-8"
    );
  }

  // -- public API -----------------------------------------------------------

  /** Record the outcome of a completed task. */
  recordOutcome(
    taskId: string,
    outcome: Outcome,
    context?: string
  ): void {
    this.entries.push({
      taskId,
      outcome,
      context,
      timestamp: new Date().toISOString(),
    });

    // Cap at MAX_ENTRIES — keep most recent
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(-MAX_ENTRIES);
    }

    this.save();
  }

  /** Analyze the last N outcomes for trend patterns. */
  getPatterns(): FeedbackPattern[] {
    const recent = this.entries.slice(-ANALYSIS_WINDOW);
    if (recent.length === 0) return [];

    const patterns: FeedbackPattern[] = [];

    // --- Outcome distribution pattern ---
    const outcomeCounts = new Map<Outcome, number>();
    for (const e of recent) {
      outcomeCounts.set(e.outcome, (outcomeCounts.get(e.outcome) ?? 0) + 1);
    }

    for (const [outcome, count] of outcomeCounts) {
      // Determine trend by comparing first half vs second half
      const mid = Math.floor(recent.length / 2);
      const firstHalf = recent.slice(0, mid);
      const secondHalf = recent.slice(mid);

      const firstCount = firstHalf.filter((e) => e.outcome === outcome).length;
      const secondCount = secondHalf.filter(
        (e) => e.outcome === outcome
      ).length;

      const firstRate = firstHalf.length > 0 ? firstCount / firstHalf.length : 0;
      const secondRate =
        secondHalf.length > 0 ? secondCount / secondHalf.length : 0;

      let trend: FeedbackPattern["trend"] = "stable";
      const delta = secondRate - firstRate;
      if (delta > 0.1) {
        trend = outcome === "accepted" ? "improving" : "declining";
      } else if (delta < -0.1) {
        trend = outcome === "accepted" ? "declining" : "improving";
      }

      patterns.push({
        pattern: `${outcome} rate: ${((count / recent.length) * 100).toFixed(0)}%`,
        frequency: count,
        trend,
      });
    }

    // --- Context-based patterns (group by context keyword) ---
    const contextCounts = new Map<string, { total: number; rejected: number }>();
    for (const e of recent) {
      if (!e.context) continue;
      const key = e.context.toLowerCase().trim();
      const existing = contextCounts.get(key) ?? { total: 0, rejected: 0 };
      existing.total++;
      if (e.outcome === "rejected" || e.outcome === "reverted") {
        existing.rejected++;
      }
      contextCounts.set(key, existing);
    }

    for (const [ctx, counts] of contextCounts) {
      if (counts.total >= 3 && counts.rejected / counts.total > 0.5) {
        patterns.push({
          pattern: `frequent rejection context: "${ctx}"`,
          frequency: counts.rejected,
          trend: "declining",
        });
      }
    }

    return patterns;
  }

  /** Overall acceptance rate across all recorded outcomes. */
  getAcceptanceRate(): number {
    if (this.entries.length === 0) return 0;
    const accepted = this.entries.filter((e) => e.outcome === "accepted").length;
    return accepted / this.entries.length;
  }

  /** Return all entries (for study sessions). */
  getAll(): FeedbackEntry[] {
    return [...this.entries];
  }

  /** Entry count. */
  get size(): number {
    return this.entries.length;
  }
}
