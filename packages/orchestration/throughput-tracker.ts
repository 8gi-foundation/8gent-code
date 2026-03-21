/**
 * Token Throughput Tracker
 *
 * Global metric tracking tokens/sec across all parallel agents, sessions, and benchmarks.
 * "What is your token throughput and what token throughput do you command." — Karpathy
 *
 * Persistence: append-only JSONL file, pruned to 7 days on startup.
 * Dependencies: Bun builtins only (fs, path, os).
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ============================================
// Types
// ============================================

export interface TokenEvent {
  sessionId: string;
  agentId: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model: string;
  durationMs: number;
  timestamp: number;
  category: "chat" | "benchmark" | "research" | "tool-call";
}

export interface ThroughputSnapshot {
  windowMs: number;
  tokensPerSecond: number;
  activeAgents: number;
  totalTokens: number;
  totalCost: number;
  peakTps: number;
  avgTps: number;
}

export interface DailyReport {
  totalTokens: number;
  totalDuration: number;
  avgTps: number;
  peakTps: number;
  modelBreakdown: Record<string, { tokens: number; calls: number; durationMs: number }>;
  categoryBreakdown: Record<string, { tokens: number; calls: number; durationMs: number }>;
}

export interface AgentUtilization {
  tokens: number;
  duration: number;
  tps: number;
}

// ============================================
// Constants
// ============================================

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const ONE_MINUTE_MS = 60 * 1000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_HISTORY_HOURS = 24;
const DEFAULT_PERSIST_FILE = path.join(os.homedir(), ".8gent", "throughput.jsonl");

// ============================================
// ThroughputTracker
// ============================================

export class ThroughputTracker {
  private events: TokenEvent[] = [];
  private persistFile: string;
  private peakTpsAllTime: number = 0;

  constructor(persistFile?: string) {
    this.persistFile = persistFile ?? DEFAULT_PERSIST_FILE;
    this.loadAndPrune();
  }

  /**
   * Record a token event. Appends to in-memory store and persists to JSONL.
   */
  record(event: TokenEvent): void {
    this.events.push(event);

    // Update peak TPS (per-event instantaneous)
    if (event.durationMs > 0) {
      const eventTps = (event.totalTokens / event.durationMs) * 1000;
      if (eventTps > this.peakTpsAllTime) {
        this.peakTpsAllTime = eventTps;
      }
    }

    // Append to file
    this.appendLine(event);
  }

  /**
   * Get a throughput snapshot over a time window.
   * @param windowMs Measurement window in ms (default 60s)
   */
  getSnapshot(windowMs: number = DEFAULT_WINDOW_MS): ThroughputSnapshot {
    const now = Date.now();
    const cutoff = now - windowMs;
    const windowEvents = this.events.filter((e) => e.timestamp >= cutoff);

    const totalTokens = windowEvents.reduce((s, e) => s + e.totalTokens, 0);
    const totalDurationMs = windowEvents.reduce((s, e) => s + e.durationMs, 0);
    const activeAgents = new Set(windowEvents.map((e) => e.agentId)).size;

    // Wall-clock TPS: total tokens produced in this window / window seconds
    const windowSec = windowMs / 1000;
    const tokensPerSecond = windowSec > 0 ? totalTokens / windowSec : 0;

    // Average TPS across individual events (compute-time TPS)
    const eventTpsValues = windowEvents
      .filter((e) => e.durationMs > 0)
      .map((e) => (e.totalTokens / e.durationMs) * 1000);
    const avgTps =
      eventTpsValues.length > 0
        ? eventTpsValues.reduce((a, b) => a + b, 0) / eventTpsValues.length
        : 0;

    // Peak TPS from individual events in this window
    const peakTps = eventTpsValues.length > 0 ? Math.max(...eventTpsValues) : 0;

    return {
      windowMs,
      tokensPerSecond: round(tokensPerSecond),
      activeAgents,
      totalTokens,
      totalCost: 0, // Free/local models — extend with pricing table if needed
      peakTps: round(peakTps),
      avgTps: round(avgTps),
    };
  }

  /**
   * Get historical snapshots over time.
   * @param hours Lookback period (default 24h)
   * @returns One snapshot per minute within the period.
   */
  getHistory(hours: number = DEFAULT_HISTORY_HOURS): ThroughputSnapshot[] {
    const now = Date.now();
    const start = now - hours * ONE_HOUR_MS;
    const snapshots: ThroughputSnapshot[] = [];

    for (let t = start; t <= now; t += ONE_MINUTE_MS) {
      const windowStart = t;
      const windowEnd = t + ONE_MINUTE_MS;
      const windowEvents = this.events.filter(
        (e) => e.timestamp >= windowStart && e.timestamp < windowEnd
      );

      if (windowEvents.length === 0) continue; // Skip empty minutes

      const totalTokens = windowEvents.reduce((s, e) => s + e.totalTokens, 0);
      const activeAgents = new Set(windowEvents.map((e) => e.agentId)).size;
      const tokensPerSecond = totalTokens / 60;

      const eventTpsValues = windowEvents
        .filter((e) => e.durationMs > 0)
        .map((e) => (e.totalTokens / e.durationMs) * 1000);
      const avgTps =
        eventTpsValues.length > 0
          ? eventTpsValues.reduce((a, b) => a + b, 0) / eventTpsValues.length
          : 0;
      const peakTps = eventTpsValues.length > 0 ? Math.max(...eventTpsValues) : 0;

      snapshots.push({
        windowMs: ONE_MINUTE_MS,
        tokensPerSecond: round(tokensPerSecond),
        activeAgents,
        totalTokens,
        totalCost: 0,
        peakTps: round(peakTps),
        avgTps: round(avgTps),
      });
    }

    return snapshots;
  }

  /**
   * Get a daily report: totals, averages, breakdowns by model and category.
   */
  getDailyReport(): DailyReport {
    const now = Date.now();
    const dayStart = now - 24 * ONE_HOUR_MS;
    const dayEvents = this.events.filter((e) => e.timestamp >= dayStart);

    const totalTokens = dayEvents.reduce((s, e) => s + e.totalTokens, 0);
    const totalDuration = dayEvents.reduce((s, e) => s + e.durationMs, 0);
    const avgTps = totalDuration > 0 ? (totalTokens / totalDuration) * 1000 : 0;

    const eventTpsValues = dayEvents
      .filter((e) => e.durationMs > 0)
      .map((e) => (e.totalTokens / e.durationMs) * 1000);
    const peakTps = eventTpsValues.length > 0 ? Math.max(...eventTpsValues) : 0;

    const modelBreakdown: DailyReport["modelBreakdown"] = {};
    const categoryBreakdown: DailyReport["categoryBreakdown"] = {};

    for (const e of dayEvents) {
      // Model breakdown
      if (!modelBreakdown[e.model]) {
        modelBreakdown[e.model] = { tokens: 0, calls: 0, durationMs: 0 };
      }
      modelBreakdown[e.model].tokens += e.totalTokens;
      modelBreakdown[e.model].calls += 1;
      modelBreakdown[e.model].durationMs += e.durationMs;

      // Category breakdown
      if (!categoryBreakdown[e.category]) {
        categoryBreakdown[e.category] = { tokens: 0, calls: 0, durationMs: 0 };
      }
      categoryBreakdown[e.category].tokens += e.totalTokens;
      categoryBreakdown[e.category].calls += 1;
      categoryBreakdown[e.category].durationMs += e.durationMs;
    }

    return {
      totalTokens,
      totalDuration: round(totalDuration),
      avgTps: round(avgTps),
      peakTps: round(peakTps),
      modelBreakdown,
      categoryBreakdown,
    };
  }

  /**
   * Get per-agent utilization stats.
   */
  getAgentUtilization(): Record<string, AgentUtilization> {
    const agents: Record<string, { tokens: number; durationMs: number }> = {};

    for (const e of this.events) {
      if (!agents[e.agentId]) {
        agents[e.agentId] = { tokens: 0, durationMs: 0 };
      }
      agents[e.agentId].tokens += e.totalTokens;
      agents[e.agentId].durationMs += e.durationMs;
    }

    const result: Record<string, AgentUtilization> = {};
    for (const [id, data] of Object.entries(agents)) {
      result[id] = {
        tokens: data.tokens,
        duration: data.durationMs,
        tps: data.durationMs > 0 ? round((data.tokens / data.durationMs) * 1000) : 0,
      };
    }

    return result;
  }

  /**
   * Get the total number of events in memory (useful for diagnostics).
   */
  getEventCount(): number {
    return this.events.length;
  }

  // ============================================
  // Persistence
  // ============================================

  private loadAndPrune(): void {
    try {
      // Ensure directory exists
      const dir = path.dirname(this.persistFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      if (!fs.existsSync(this.persistFile)) return;

      const raw = fs.readFileSync(this.persistFile, "utf-8");
      const cutoff = Date.now() - SEVEN_DAYS_MS;
      const kept: TokenEvent[] = [];

      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const event: TokenEvent = JSON.parse(line);
          if (event.timestamp >= cutoff) {
            kept.push(event);

            // Rebuild peak TPS
            if (event.durationMs > 0) {
              const tps = (event.totalTokens / event.durationMs) * 1000;
              if (tps > this.peakTpsAllTime) this.peakTpsAllTime = tps;
            }
          }
        } catch {
          // Skip malformed lines
        }
      }

      this.events = kept;

      // Rewrite file with only kept events (prune old)
      if (kept.length > 0) {
        const pruned = kept.map((e) => JSON.stringify(e)).join("\n") + "\n";
        fs.writeFileSync(this.persistFile, pruned, "utf-8");
      } else {
        // Truncate if nothing kept
        fs.writeFileSync(this.persistFile, "", "utf-8");
      }
    } catch {
      // If file is unreadable, start fresh
      this.events = [];
    }
  }

  private appendLine(event: TokenEvent): void {
    try {
      const dir = path.dirname(this.persistFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.appendFileSync(this.persistFile, JSON.stringify(event) + "\n", "utf-8");
    } catch {
      // Silent fail — don't break the caller over persistence
    }
  }
}

// ============================================
// Singleton
// ============================================

let instance: ThroughputTracker | null = null;

export function getThroughputTracker(persistFile?: string): ThroughputTracker {
  if (!instance) {
    instance = new ThroughputTracker(persistFile);
  }
  return instance;
}

export function resetThroughputTracker(): void {
  instance = null;
}

// ============================================
// Helpers
// ============================================

function round(n: number, decimals: number = 2): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}
