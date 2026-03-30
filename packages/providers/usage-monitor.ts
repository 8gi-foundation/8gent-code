/**
 * Usage Monitor - tracks token consumption against daily/weekly budgets.
 * Prevents vessels from burning through free tier limits.
 *
 * Persists to ~/.8gent/usage.json
 */

import * as fs from "fs";
import * as path from "path";

interface UsageRecord {
  date: string; // YYYY-MM-DD
  tokens: number;
  requests: number;
  cost: number; // estimated USD
}

interface UsageBudget {
  dailyTokens: number;   // max tokens per day (default 500k for free tier)
  weeklyTokens: number;  // max tokens per week (default 2M)
  dailyRequests: number; // max requests per day (default 200)
  weeklyRequests: number;
  warningThreshold: number; // 0-1, warn at this % (default 0.8)
}

interface UsageState {
  records: UsageRecord[];
  budget: UsageBudget;
  lastWarning?: string;
}

const USAGE_PATH = path.join(process.env.HOME || "", ".8gent", "usage.json");

const DEFAULT_BUDGET: UsageBudget = {
  dailyTokens: 500_000,
  weeklyTokens: 2_000_000,
  dailyRequests: 200,
  weeklyRequests: 1000,
  warningThreshold: 0.8,
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function weekStart(): string {
  const d = new Date();
  d.setDate(d.getDate() - d.getDay());
  return d.toISOString().slice(0, 10);
}

function loadState(): UsageState {
  try {
    if (fs.existsSync(USAGE_PATH)) {
      return JSON.parse(fs.readFileSync(USAGE_PATH, "utf-8"));
    }
  } catch {}
  return { records: [], budget: { ...DEFAULT_BUDGET } };
}

function saveState(state: UsageState): void {
  const dir = path.dirname(USAGE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(USAGE_PATH, JSON.stringify(state, null, 2));
}

export class UsageMonitor {
  private state: UsageState;

  constructor() {
    this.state = loadState();
  }

  /** Record token usage from a request */
  record(tokens: number, cost = 0): void {
    const d = today();
    let rec = this.state.records.find(r => r.date === d);
    if (!rec) {
      rec = { date: d, tokens: 0, requests: 0, cost: 0 };
      this.state.records.push(rec);
    }
    rec.tokens += tokens;
    rec.requests += 1;
    rec.cost += cost;
    // Keep only last 30 days
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    this.state.records = this.state.records.filter(r => r.date >= cutoff.toISOString().slice(0, 10));
    saveState(this.state);
  }

  /** Check if we're within budget. Returns { allowed, reason?, usage } */
  check(): { allowed: boolean; reason?: string; dailyUsed: number; weeklyUsed: number; dailyPct: number; weeklyPct: number } {
    const b = this.state.budget;
    const d = today();
    const ws = weekStart();
    const dailyRec = this.state.records.find(r => r.date === d);
    const weeklyTokens = this.state.records.filter(r => r.date >= ws).reduce((sum, r) => sum + r.tokens, 0);
    const dailyTokens = dailyRec?.tokens || 0;
    const dailyPct = dailyTokens / b.dailyTokens;
    const weeklyPct = weeklyTokens / b.weeklyTokens;

    if (dailyTokens >= b.dailyTokens) {
      return { allowed: false, reason: `Daily token limit reached (${dailyTokens.toLocaleString()}/${b.dailyTokens.toLocaleString()})`, dailyUsed: dailyTokens, weeklyUsed: weeklyTokens, dailyPct, weeklyPct };
    }
    if (weeklyTokens >= b.weeklyTokens) {
      return { allowed: false, reason: `Weekly token limit reached (${weeklyTokens.toLocaleString()}/${b.weeklyTokens.toLocaleString()})`, dailyUsed: dailyTokens, weeklyUsed: weeklyTokens, dailyPct, weeklyPct };
    }
    const dailyReqs = dailyRec?.requests || 0;
    if (dailyReqs >= b.dailyRequests) {
      return { allowed: false, reason: `Daily request limit reached (${dailyReqs}/${b.dailyRequests})`, dailyUsed: dailyTokens, weeklyUsed: weeklyTokens, dailyPct, weeklyPct };
    }
    return { allowed: true, dailyUsed: dailyTokens, weeklyUsed: weeklyTokens, dailyPct, weeklyPct };
  }

  /** Get warning if approaching limits */
  getWarning(): string | null {
    const { dailyPct, weeklyPct } = this.check();
    const t = this.state.budget.warningThreshold;
    if (dailyPct >= t) return `Daily usage at ${Math.round(dailyPct * 100)}% - slow down`;
    if (weeklyPct >= t) return `Weekly usage at ${Math.round(weeklyPct * 100)}% - pace yourselves`;
    return null;
  }

  /** Get usage summary */
  getSummary(): string {
    const { dailyUsed, weeklyUsed, dailyPct, weeklyPct } = this.check();
    const b = this.state.budget;
    return [
      `Daily:  ${dailyUsed.toLocaleString()} / ${b.dailyTokens.toLocaleString()} tokens (${Math.round(dailyPct * 100)}%)`,
      `Weekly: ${weeklyUsed.toLocaleString()} / ${b.weeklyTokens.toLocaleString()} tokens (${Math.round(weeklyPct * 100)}%)`,
    ].join("\n");
  }

  /** Update budget limits */
  setBudget(overrides: Partial<UsageBudget>): void {
    this.state.budget = { ...this.state.budget, ...overrides };
    saveState(this.state);
  }
}

let instance: UsageMonitor | null = null;
export function getUsageMonitor(): UsageMonitor {
  if (!instance) instance = new UsageMonitor();
  return instance;
}
