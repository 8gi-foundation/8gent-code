/**
 * Health Check - Comprehensive daemon health report.
 *
 * Returns structured JSON covering daemon status, Ollama connectivity,
 * memory usage, disk space, active sessions, cron jobs, and last error.
 * Designed to be called from the gateway's /health endpoint or CLI.
 */

import { existsSync, statSync, readFileSync } from "fs";
import { getJobs, type CronJob } from "./cron";
import { getDataDir } from "./data-dir";

const DATA_DIR = getDataDir();
const ERROR_LOG_PATH = `${DATA_DIR}/daemon-error.log`;
const OLLAMA_URL = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";

export interface HealthReport {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: string;
  uptimeSeconds: number;
  daemon: { pid: number; version: string; dataDir: string };
  ollama: { reachable: boolean; latencyMs: number | null; error: string | null };
  memory: { rssBytes: number; heapUsedBytes: number; heapTotalBytes: number; externalBytes: number };
  disk: { dataDir: string; availableBytes: number | null; usedBytes: number | null; error: string | null };
  sessions: { active: number; list: Array<{ id: string; channel: string; messages: number; busy: boolean }> };
  cron: { total: number; enabled: number; jobs: Array<{ id: string; name: string; enabled: boolean; lastRun: string | null }> };
  lastError: string | null;
}

const startTime = Date.now();

/** Ping Ollama /api/tags to check connectivity */
async function checkOllama(): Promise<HealthReport["ollama"]> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      return { reachable: false, latencyMs: Date.now() - t0, error: `HTTP ${res.status}` };
    }
    return { reachable: true, latencyMs: Date.now() - t0, error: null };
  } catch (err) {
    return { reachable: false, latencyMs: null, error: String(err) };
  }
}

/** Get disk space for the data directory via df */
async function checkDisk(): Promise<HealthReport["disk"]> {
  try {
    const proc = Bun.spawn(["df", "-k", DATA_DIR], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    const lines = out.trim().split("\n");
    if (lines.length < 2) {
      return { dataDir: DATA_DIR, availableBytes: null, usedBytes: null, error: "unexpected df output" };
    }
    const cols = lines[1].split(/\s+/);
    // df -k columns: Filesystem 1K-blocks Used Available Capacity Mounted
    const usedKb = parseInt(cols[2], 10);
    const availKb = parseInt(cols[3], 10);
    return {
      dataDir: DATA_DIR,
      availableBytes: isNaN(availKb) ? null : availKb * 1024,
      usedBytes: isNaN(usedKb) ? null : usedKb * 1024,
      error: null,
    };
  } catch (err) {
    return { dataDir: DATA_DIR, availableBytes: null, usedBytes: null, error: String(err) };
  }
}

/** Read the last error from the daemon error log */
function getLastError(): string | null {
  try {
    if (!existsSync(ERROR_LOG_PATH)) return null;
    const stat = statSync(ERROR_LOG_PATH);
    if (stat.size === 0) return null;
    // Read last 1KB to find the final line
    const fd = require("fs").openSync(ERROR_LOG_PATH, "r");
    const size = Math.min(stat.size, 1024);
    const buf = Buffer.alloc(size);
    require("fs").readSync(fd, buf, 0, size, stat.size - size);
    require("fs").closeSync(fd);
    const lines = buf.toString("utf-8").trim().split("\n").filter(Boolean);
    return lines.length > 0 ? lines[lines.length - 1] : null;
  } catch {
    return null;
  }
}

/** Build a full health report. Pass the AgentPool to include session data. */
export async function buildHealthReport(pool?: {
  size: number;
  getActiveSessions: () => Array<{ sessionId: string; channel: string; messageCount: number }>;
  getSessionInfo: (id: string) => { busy: boolean } | null;
}): Promise<HealthReport> {
  const [ollama, disk] = await Promise.all([checkOllama(), checkDisk()]);

  const mem = process.memoryUsage();

  const cronJobs: CronJob[] = getJobs();
  const enabledCount = cronJobs.filter((j) => j.enabled).length;

  const sessionList: HealthReport["sessions"]["list"] = [];
  if (pool) {
    for (const s of pool.getActiveSessions()) {
      const info = pool.getSessionInfo(s.sessionId);
      sessionList.push({
        id: s.sessionId,
        channel: s.channel,
        messages: s.messageCount,
        busy: info?.busy ?? false,
      });
    }
  }

  const lastError = getLastError();

  // Determine overall status
  let status: HealthReport["status"] = "healthy";
  if (!ollama.reachable) status = "degraded";
  if (lastError) status = "degraded";
  if (disk.error) status = "degraded";

  return {
    status,
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round((Date.now() - startTime) / 1000),
    daemon: { pid: process.pid, version: "1.0.0", dataDir: DATA_DIR },
    ollama,
    memory: {
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
      externalBytes: mem.external,
    },
    disk,
    sessions: { active: pool?.size ?? 0, list: sessionList },
    cron: {
      total: cronJobs.length,
      enabled: enabledCount,
      jobs: cronJobs.map((j) => ({ id: j.id, name: j.name, enabled: j.enabled, lastRun: j.lastRun })),
    },
    lastError,
  };
}
