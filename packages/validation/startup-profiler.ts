/**
 * 8gent Code - Startup Profiler
 *
 * Measures TUI and daemon startup times, identifies slow imports,
 * and tracks cold vs warm start performance. Results are written
 * to .8gent/startup-profile.json for trend analysis.
 *
 * Usage:
 *   import { profileStartup } from "./startup-profiler";
 *   const report = await profileStartup({ target: "tui" });
 *   console.log(report.totalMs, report.slowImports);
 */

import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

// ============================================
// Types
// ============================================

export type StartupTarget = "tui" | "daemon";

export interface ImportTiming {
  module: string;
  ms: number;
}

export interface StartupProfile {
  target: StartupTarget;
  timestamp: string;
  totalMs: number;
  cold: boolean;
  slowImports: ImportTiming[];
  phases: Record<string, number>;
}

export interface ProfilerOptions {
  target: StartupTarget;
  cwd?: string;
  slowThresholdMs?: number;
}

// ============================================
// Constants
// ============================================

const DATA_DIR = ".8gent";
const PROFILE_FILE = "startup-profile.json";
const DEFAULT_SLOW_THRESHOLD = 50;

const TARGET_ENTRIES: Record<StartupTarget, string> = {
  tui: "apps/tui/src/index.tsx",
  daemon: "packages/daemon/index.ts",
};

// ============================================
// Core
// ============================================

function isColdStart(dataDir: string): boolean {
  const historyPath = join(dataDir, PROFILE_FILE);
  if (!existsSync(historyPath)) return true;
  try {
    const raw = JSON.parse(readFileSync(historyPath, "utf-8"));
    const profiles: StartupProfile[] = Array.isArray(raw) ? raw : [];
    if (profiles.length === 0) return true;
    const last = profiles[profiles.length - 1];
    const elapsed = Date.now() - new Date(last.timestamp).getTime();
    return elapsed > 5 * 60 * 1000;
  } catch {
    return true;
  }
}

function traceImports(
  target: StartupTarget,
  cwd: string,
  slowThresholdMs: number
): { totalMs: number; slowImports: ImportTiming[]; phases: Record<string, number> } {
  const entry = TARGET_ENTRIES[target];
  const entryPath = join(cwd, entry);

  if (!existsSync(entryPath)) {
    return { totalMs: -1, slowImports: [], phases: { error: -1 } };
  }

  const startAll = performance.now();

  const phaseStart = performance.now();
  const result = spawnSync("bun", ["build", "--target=bun", entryPath, "--outdir=/dev/null"], {
    cwd,
    timeout: 15_000,
    encoding: "utf-8",
    env: { ...process.env, NODE_ENV: "production" },
  });
  const resolutionMs = performance.now() - phaseStart;

  const slowImports: ImportTiming[] = [];
  const output = (result.stderr || "") + (result.stdout || "");
  const importRe = /(\d+(?:\.\d+)?)\s*ms\s+(.+)/g;
  let match: RegExpExecArray | null;
  while ((match = importRe.exec(output)) !== null) {
    const ms = parseFloat(match[1]);
    if (ms >= slowThresholdMs) {
      slowImports.push({ module: match[2].trim(), ms });
    }
  }
  slowImports.sort((a, b) => b.ms - a.ms);

  const totalMs = performance.now() - startAll;
  const phases = { resolution: Math.round(resolutionMs), total: Math.round(totalMs) };

  return { totalMs: Math.round(totalMs), slowImports, phases };
}

export async function profileStartup(opts: ProfilerOptions): Promise<StartupProfile> {
  const cwd = opts.cwd || process.cwd();
  const slowThreshold = opts.slowThresholdMs ?? DEFAULT_SLOW_THRESHOLD;
  const dataDir = join(cwd, DATA_DIR);

  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  const cold = isColdStart(dataDir);
  const { totalMs, slowImports, phases } = traceImports(opts.target, cwd, slowThreshold);

  const profile: StartupProfile = {
    target: opts.target,
    timestamp: new Date().toISOString(),
    totalMs,
    cold,
    slowImports,
    phases,
  };

  const historyPath = join(dataDir, PROFILE_FILE);
  let history: StartupProfile[] = [];
  try {
    if (existsSync(historyPath)) {
      history = JSON.parse(readFileSync(historyPath, "utf-8"));
    }
  } catch { /* start fresh */ }
  history.push(profile);
  if (history.length > 50) history = history.slice(-50);
  writeFileSync(historyPath, JSON.stringify(history, null, 2));

  return profile;
}

export function summarizeProfiles(cwd?: string): {
  avgColdMs: number;
  avgWarmMs: number;
  trend: "improving" | "stable" | "degrading";
  count: number;
} {
  const dataDir = join(cwd || process.cwd(), DATA_DIR);
  const historyPath = join(dataDir, PROFILE_FILE);
  if (!existsSync(historyPath)) return { avgColdMs: 0, avgWarmMs: 0, trend: "stable", count: 0 };

  const profiles: StartupProfile[] = JSON.parse(readFileSync(historyPath, "utf-8"));
  const cold = profiles.filter((p) => p.cold && p.totalMs > 0);
  const warm = profiles.filter((p) => !p.cold && p.totalMs > 0);

  const avg = (arr: StartupProfile[]) =>
    arr.length ? Math.round(arr.reduce((s, p) => s + p.totalMs, 0) / arr.length) : 0;

  const avgColdMs = avg(cold);
  const avgWarmMs = avg(warm);

  let trend: "improving" | "stable" | "degrading" = "stable";
  if (profiles.length >= 10) {
    const recent = avg(profiles.slice(-5));
    const older = avg(profiles.slice(-10, -5));
    if (recent < older * 0.9) trend = "improving";
    else if (recent > older * 1.1) trend = "degrading";
  }

  return { avgColdMs, avgWarmMs, trend, count: profiles.length };
}
