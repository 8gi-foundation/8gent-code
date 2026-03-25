/**
 * 8gent - System Metrics Collector
 *
 * Collects and aggregates system metrics: CPU, memory, disk, Ollama model status,
 * daemon uptime. Stores time-series data in ~/.8gent/metrics/.
 *
 * Usage:
 *   const collector = new MetricsCollector();
 *   const snapshot = await collector.collect();
 *   await collector.store(snapshot);
 *   const history = await collector.query({ last: 60 }); // last 60 minutes
 */

import { join } from "path";
import { mkdir } from "node:fs/promises";
import { cpus, totalmem, freemem, uptime as osUptime } from "node:os";
import { execSync } from "node:child_process";

// ============================================
// Types
// ============================================

export interface CpuMetrics {
  count: number;
  loadAvg1m: number;
  loadAvg5m: number;
  loadAvg15m: number;
}

export interface MemoryMetrics {
  totalMb: number;
  freeMb: number;
  usedMb: number;
  usedPercent: number;
}

export interface DiskMetrics {
  totalGb: number;
  usedGb: number;
  availGb: number;
  usedPercent: number;
}

export interface OllamaModel {
  name: string;
  size: string;
  modified: string;
}

export interface OllamaMetrics {
  running: boolean;
  models: OllamaModel[];
  runningModels: string[];
}

export interface DaemonMetrics {
  reachable: boolean;
  uptimeMs: number | null;
  url: string;
}

export interface MetricsSnapshot {
  timestamp: string;
  epochMs: number;
  osUptimeSec: number;
  cpu: CpuMetrics;
  memory: MemoryMetrics;
  disk: DiskMetrics;
  ollama: OllamaMetrics;
  daemon: DaemonMetrics;
}

export interface QueryOptions {
  /** Return snapshots from the last N minutes */
  last?: number;
  /** Maximum number of snapshots to return */
  limit?: number;
}

// ============================================
// Constants
// ============================================

const METRICS_DIR = join(process.env.HOME || "~", ".8gent", "metrics");
const DAEMON_URL = "https://eight-vessel.fly.dev";

// ============================================
// Collector
// ============================================

export class MetricsCollector {
  private metricsDir: string;
  private daemonUrl: string;

  constructor(opts?: { metricsDir?: string; daemonUrl?: string }) {
    this.metricsDir = opts?.metricsDir ?? METRICS_DIR;
    this.daemonUrl = opts?.daemonUrl ?? DAEMON_URL;
  }

  /** Collect a full system snapshot */
  async collect(): Promise<MetricsSnapshot> {
    const [disk, ollama, daemon] = await Promise.all([
      this.collectDisk(),
      this.collectOllama(),
      this.collectDaemon(),
    ]);

    const now = new Date();
    const loadAvg = (() => {
      try {
        const raw = execSync("sysctl -n vm.loadavg 2>/dev/null || cat /proc/loadavg 2>/dev/null", {
          encoding: "utf-8",
          timeout: 3000,
        }).trim();
        const nums = raw.replace(/[{}]/g, "").trim().split(/\s+/).map(Number).filter(n => !isNaN(n));
        return nums.length >= 3 ? nums : [0, 0, 0];
      } catch {
        return [0, 0, 0];
      }
    })();

    const totalMb = Math.round(totalmem() / 1024 / 1024);
    const freeMb = Math.round(freemem() / 1024 / 1024);
    const usedMb = totalMb - freeMb;

    return {
      timestamp: now.toISOString(),
      epochMs: now.getTime(),
      osUptimeSec: Math.round(osUptime()),
      cpu: {
        count: cpus().length,
        loadAvg1m: loadAvg[0],
        loadAvg5m: loadAvg[1],
        loadAvg15m: loadAvg[2],
      },
      memory: {
        totalMb,
        freeMb,
        usedMb,
        usedPercent: Math.round((usedMb / totalMb) * 100),
      },
      disk,
      ollama,
      daemon,
    };
  }

  /** Store a snapshot to disk as JSONL (one file per day) */
  async store(snapshot: MetricsSnapshot): Promise<string> {
    await mkdir(this.metricsDir, { recursive: true });
    const dayKey = snapshot.timestamp.slice(0, 10); // YYYY-MM-DD
    const filePath = join(this.metricsDir, `${dayKey}.jsonl`);
    const line = JSON.stringify(snapshot) + "\n";

    const file = Bun.file(filePath);
    const existing = await file.exists() ? await file.text() : "";
    await Bun.write(filePath, existing + line);
    return filePath;
  }

  /** Query stored snapshots */
  async query(opts: QueryOptions = {}): Promise<MetricsSnapshot[]> {
    const { last = 60, limit = 100 } = opts;
    const cutoff = Date.now() - last * 60 * 1000;
    const results: MetricsSnapshot[] = [];

    // Read today's file and yesterday's (covers the boundary)
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    for (const dayKey of [yesterday, today]) {
      const filePath = join(this.metricsDir, `${dayKey}.jsonl`);
      try {
        const text = await Bun.file(filePath).text();
        for (const line of text.trim().split("\n")) {
          if (!line) continue;
          const snap = JSON.parse(line) as MetricsSnapshot;
          if (snap.epochMs >= cutoff) results.push(snap);
        }
      } catch {
        // File doesn't exist yet
      }
    }

    return results.slice(-limit);
  }

  private async collectDisk(): Promise<DiskMetrics> {
    try {
      const raw = execSync("df -g / 2>/dev/null || df -BG / 2>/dev/null", {
        encoding: "utf-8",
        timeout: 3000,
      });
      const lines = raw.trim().split("\n");
      if (lines.length < 2) return { totalGb: 0, usedGb: 0, availGb: 0, usedPercent: 0 };
      const parts = lines[1].split(/\s+/);
      const totalGb = parseInt(parts[1]) || 0;
      const usedGb = parseInt(parts[2]) || 0;
      const availGb = parseInt(parts[3]) || 0;
      const pctStr = parts[4]?.replace("%", "") || "0";
      return { totalGb, usedGb, availGb, usedPercent: parseInt(pctStr) || 0 };
    } catch {
      return { totalGb: 0, usedGb: 0, availGb: 0, usedPercent: 0 };
    }
  }

  private async collectOllama(): Promise<OllamaMetrics> {
    const result: OllamaMetrics = { running: false, models: [], runningModels: [] };
    try {
      const listRaw = execSync("ollama list 2>/dev/null", { encoding: "utf-8", timeout: 5000 });
      result.running = true;
      const lines = listRaw.trim().split("\n").slice(1);
      result.models = lines.filter(l => l.trim()).map(line => {
        const parts = line.split(/\s{2,}/);
        return { name: parts[0] || "", size: parts[1] || "", modified: parts[2] || "" };
      });
    } catch {
      return result;
    }

    try {
      const psRaw = execSync("ollama ps 2>/dev/null", { encoding: "utf-8", timeout: 5000 });
      const psLines = psRaw.trim().split("\n").slice(1);
      result.runningModels = psLines.filter(l => l.trim()).map(l => l.split(/\s+/)[0] || "");
    } catch { /* non-critical */ }

    return result;
  }

  private async collectDaemon(): Promise<DaemonMetrics> {
    const result: DaemonMetrics = { reachable: false, uptimeMs: null, url: this.daemonUrl };
    try {
      const start = Date.now();
      const resp = await fetch(`${this.daemonUrl}/health`, { signal: AbortSignal.timeout(5000) });
      const elapsed = Date.now() - start;
      result.reachable = resp.ok;
      if (resp.ok) {
        const body = await resp.json().catch(() => null) as Record<string, unknown> | null;
        result.uptimeMs = typeof body?.uptimeMs === "number" ? body.uptimeMs : elapsed;
      }
    } catch { /* daemon not reachable */ }
    return result;
  }
}

// ============================================
// Convenience
// ============================================

/** One-shot: collect + store + return */
export async function collectAndStore(): Promise<MetricsSnapshot> {
  const collector = new MetricsCollector();
  const snapshot = await collector.collect();
  await collector.store(snapshot);
  return snapshot;
}

/** Quick system summary string */
export async function systemSummary(): Promise<string> {
  const collector = new MetricsCollector();
  const s = await collector.collect();
  const lines = [
    `CPU: ${s.cpu.count} cores, load ${s.cpu.loadAvg1m}/${s.cpu.loadAvg5m}/${s.cpu.loadAvg15m}`,
    `RAM: ${s.memory.usedMb}/${s.memory.totalMb} MB (${s.memory.usedPercent}%)`,
    `Disk: ${s.disk.usedGb}/${s.disk.totalGb} GB (${s.disk.usedPercent}%)`,
    `Ollama: ${s.ollama.running ? `running, ${s.ollama.models.length} models` : "offline"}`,
    `Daemon: ${s.daemon.reachable ? "reachable" : "offline"} (${s.daemon.url})`,
  ];
  return lines.join("\n");
}
