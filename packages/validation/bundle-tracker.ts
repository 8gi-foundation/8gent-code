/**
 * Bundle Size Tracker
 *
 * Tracks dist/ bundle sizes across builds, alerts on significant increases (>10%),
 * and generates a size history report. Stores history in .8gent/bundle-history.json.
 */

import { existsSync, statSync, readdirSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join, relative } from "path";

export interface BundleEntry {
  file: string;
  bytes: number;
}

export interface BundleSnapshot {
  timestamp: string;
  totalBytes: number;
  files: BundleEntry[];
}

export interface BundleAlert {
  file: string;
  previousBytes: number;
  currentBytes: number;
  increasePercent: number;
}

const HISTORY_PATH = join(process.cwd(), ".8gent", "bundle-history.json");
const ALERT_THRESHOLD = 0.10; // 10%

function walkDir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkDir(full));
    else results.push(full);
  }
  return results;
}

export function scanDist(distDir: string): BundleEntry[] {
  return walkDir(distDir).map((f) => ({
    file: relative(distDir, f),
    bytes: statSync(f).size,
  }));
}

export function loadHistory(): BundleSnapshot[] {
  if (!existsSync(HISTORY_PATH)) return [];
  try {
    return JSON.parse(readFileSync(HISTORY_PATH, "utf-8"));
  } catch {
    return [];
  }
}

function saveHistory(history: BundleSnapshot[]): void {
  const dir = join(process.cwd(), ".8gent");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
}

export function detectAlerts(previous: BundleSnapshot, current: BundleSnapshot): BundleAlert[] {
  const prevMap = new Map(previous.files.map((f) => [f.file, f.bytes]));
  const alerts: BundleAlert[] = [];
  for (const entry of current.files) {
    const prev = prevMap.get(entry.file);
    if (prev && prev > 0) {
      const increase = (entry.bytes - prev) / prev;
      if (increase > ALERT_THRESHOLD) {
        alerts.push({
          file: entry.file,
          previousBytes: prev,
          currentBytes: entry.bytes,
          increasePercent: Math.round(increase * 100),
        });
      }
    }
  }
  return alerts;
}

export function track(distDir = "dist"): { snapshot: BundleSnapshot; alerts: BundleAlert[] } {
  const files = scanDist(distDir);
  const totalBytes = files.reduce((sum, f) => sum + f.bytes, 0);
  const snapshot: BundleSnapshot = { timestamp: new Date().toISOString(), totalBytes, files };

  const history = loadHistory();
  const previous = history.length > 0 ? history[history.length - 1] : null;
  const alerts = previous ? detectAlerts(previous, snapshot) : [];

  history.push(snapshot);
  saveHistory(history);

  return { snapshot, alerts };
}

export function report(): string {
  const history = loadHistory();
  if (history.length === 0) return "No bundle history recorded yet.";
  const lines = ["Bundle Size History", "---"];
  for (const snap of history) {
    const kb = (snap.totalBytes / 1024).toFixed(1);
    lines.push(`${snap.timestamp} - ${kb} KB (${snap.files.length} files)`);
  }
  return lines.join("\n");
}
