/**
 * 8gent Code - Process Manager
 *
 * Lists running processes with memory usage and provides graceful/force quit.
 * Inspired by Quitty (github.com/iad1tya/Quitty) - rebuilt from scratch for
 * cross-platform Node/Bun with security-first design.
 *
 * Security model:
 * - Listing processes is always allowed (read-only)
 * - Quitting requires user confirmation via NemoClaw policy
 * - System-critical processes are hard-blocked from termination
 * - Safe list is user-configurable via .8gent/safe-apps.json
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { CommandResult } from "./types";

// ============================================
// Types
// ============================================

export interface ProcessInfo {
  pid: number;
  name: string;
  memoryMB: number;
  cpu?: number;
  user?: string;
}

export type SortMode = "memory" | "name" | "cpu";
export type QuitStrategy = "graceful" | "force";

// ============================================
// Security - Protected processes
// ============================================

/** Processes that should NEVER be killed - system stability depends on them */
const SYSTEM_CRITICAL: Set<string> = new Set([
  "kernel_task",
  "launchd",
  "WindowServer",
  "loginwindow",
  "systemd",
  "init",
  "sshd",
  "coreaudiod",
  "coreservicesd",
  "opendirectoryd",
  "diskarbitrationd",
  "fseventsd",
  "mds",
  "mds_stores",
  "notifyd",
  "configd",
  "powerd",
  "thermalmonitord",
  "logd",
  "UserEventAgent",
  "Dock",      // killing Dock causes desktop to vanish until relaunch
  "Finder",    // killing Finder disrupts file management
  "SystemUIServer",
]);

/** Our own processes - never kill ourselves */
const SELF_PROCESSES: Set<string> = new Set([
  "8gent",
  "bun",
  "node",
  "Electron", // in case running via Tauri/Electron wrapper
]);

/** Max processes to return in a listing (prevent overwhelming the LLM) */
const MAX_PROCESS_LIST = 50;

// ============================================
// Safe list (user-configurable)
// ============================================

function getSafeListPath(): string {
  const dataDir = process.env.EIGHT_DATA_DIR || path.join(os.homedir(), ".8gent");
  return path.join(dataDir, "safe-apps.json");
}

/**
 * Load the user's safe app list. Apps on this list are skipped during "quit idle".
 */
export function loadSafeList(): string[] {
  try {
    const raw = fs.readFileSync(getSafeListPath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((s): s is string => typeof s === "string");
    return [];
  } catch {
    return [];
  }
}

/**
 * Save the user's safe app list.
 */
export function saveSafeList(apps: string[]): void {
  const safeListPath = getSafeListPath();
  const dir = path.dirname(safeListPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(safeListPath, JSON.stringify(apps, null, 2));
}

/**
 * Add an app to the safe list.
 */
export function addToSafeList(appName: string): string {
  const list = loadSafeList();
  const normalized = appName.trim();
  if (list.includes(normalized)) return `"${normalized}" is already on the safe list`;
  list.push(normalized);
  saveSafeList(list);
  return `Added "${normalized}" to safe list (${list.length} apps protected)`;
}

/**
 * Remove an app from the safe list.
 */
export function removeFromSafeList(appName: string): string {
  const list = loadSafeList();
  const normalized = appName.trim();
  const idx = list.indexOf(normalized);
  if (idx === -1) return `"${normalized}" is not on the safe list`;
  list.splice(idx, 1);
  saveSafeList(list);
  return `Removed "${normalized}" from safe list (${list.length} apps protected)`;
}

// ============================================
// Process listing
// ============================================

/**
 * List running user-facing processes with memory usage.
 * Cross-platform: macOS (ps) and Linux (ps).
 */
export function listProcesses(sort: SortMode = "memory"): ProcessInfo[] {
  try {
    const platform = os.platform();
    let raw: string;

    if (platform === "darwin") {
      // macOS: get user-facing apps + their memory via ps
      raw = execSync(
        "ps -eo pid,rss,pcpu,user,comm -r",
        { encoding: "utf-8", timeout: 5000 }
      );
    } else {
      // Linux
      raw = execSync(
        "ps -eo pid,rss,pcpu,user,comm --sort=-rss",
        { encoding: "utf-8", timeout: 5000 }
      );
    }

    const lines = raw.trim().split("\n").slice(1); // skip header
    const processes: ProcessInfo[] = [];

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5) continue;

      const pid = parseInt(parts[0], 10);
      const rssKB = parseInt(parts[1], 10);
      const cpu = parseFloat(parts[2]);
      const user = parts[3];
      // comm can contain paths - extract just the binary name
      const fullPath = parts.slice(4).join(" ");
      const name = path.basename(fullPath);

      if (isNaN(pid) || isNaN(rssKB)) continue;

      // Skip kernel threads and very small processes
      if (rssKB < 1024) continue; // less than 1MB

      processes.push({
        pid,
        name,
        memoryMB: Math.round(rssKB / 1024),
        cpu: Math.round(cpu * 10) / 10,
        user,
      });
    }

    // Sort
    if (sort === "memory") {
      processes.sort((a, b) => b.memoryMB - a.memoryMB);
    } else if (sort === "cpu") {
      processes.sort((a, b) => (b.cpu ?? 0) - (a.cpu ?? 0));
    } else {
      processes.sort((a, b) => a.name.localeCompare(b.name));
    }

    return processes.slice(0, MAX_PROCESS_LIST);
  } catch (err) {
    return [];
  }
}

/**
 * Get total system memory usage summary.
 */
export function getMemorySummary(): { totalMB: number; freeMB: number; usedMB: number; usedPercent: number } {
  const totalMB = Math.round(os.totalmem() / (1024 * 1024));
  const freeMB = Math.round(os.freemem() / (1024 * 1024));
  const usedMB = totalMB - freeMB;
  const usedPercent = Math.round((usedMB / totalMB) * 100);
  return { totalMB, freeMB, usedMB, usedPercent };
}

// ============================================
// Process termination (security-gated)
// ============================================

/**
 * Check if a process name is safe to quit.
 * Returns null if OK, error string if blocked.
 */
function canQuit(name: string): string | null {
  if (SYSTEM_CRITICAL.has(name)) {
    return `BLOCKED: "${name}" is a system-critical process and cannot be terminated`;
  }
  if (SELF_PROCESSES.has(name)) {
    return `BLOCKED: "${name}" is part of the 8gent runtime - cannot terminate self`;
  }
  return null;
}

/**
 * Quit a single process by PID.
 * Graceful sends SIGTERM, force sends SIGKILL.
 */
export function quitProcess(pid: number, strategy: QuitStrategy = "graceful"): CommandResult {
  // Validate PID
  if (!Number.isInteger(pid) || pid < 1 || pid > 4194304) {
    return { ok: false, error: `Invalid PID: ${pid}` };
  }

  // Look up process name for safety check
  try {
    const info = execSync(`ps -p ${pid} -o comm=`, { encoding: "utf-8", timeout: 3000 }).trim();
    const name = path.basename(info);
    const blockReason = canQuit(name);
    if (blockReason) return { ok: false, error: blockReason };
  } catch {
    return { ok: false, error: `Process ${pid} not found or already terminated` };
  }

  try {
    const signal = strategy === "force" ? "SIGKILL" : "SIGTERM";
    process.kill(pid, signal);
    return { ok: true };
  } catch (err: any) {
    if (err.code === "ESRCH") {
      return { ok: true }; // already dead
    }
    if (err.code === "EPERM") {
      return { ok: false, error: `Permission denied: cannot terminate PID ${pid} (owned by another user)` };
    }
    return { ok: false, error: `Failed to terminate PID ${pid}: ${err.message}` };
  }
}

/**
 * Quit a process by name.
 * Finds the PID first, then terminates.
 */
export function quitByName(name: string, strategy: QuitStrategy = "graceful"): CommandResult {
  const blockReason = canQuit(name);
  if (blockReason) return { ok: false, error: blockReason };

  try {
    const signal = strategy === "force" ? "-9" : "-15";
    execSync(`pkill ${signal} -x "${name.replace(/"/g, "")}"`, {
      encoding: "utf-8",
      timeout: 5000,
    });
    return { ok: true };
  } catch (err: any) {
    if (err.status === 1) {
      return { ok: false, error: `No process named "${name}" found` };
    }
    return { ok: false, error: `Failed to quit "${name}": ${err.message}` };
  }
}

/**
 * Suggest idle/resource-hogging apps that could be quit to free resources.
 * Returns apps sorted by memory that are NOT in the safe list and NOT system-critical.
 */
export function suggestQuittable(): { apps: ProcessInfo[]; safeList: string[]; memSummary: ReturnType<typeof getMemorySummary> } {
  const all = listProcesses("memory");
  const safeList = loadSafeList();

  const quittable = all.filter((p) => {
    if (SYSTEM_CRITICAL.has(p.name)) return false;
    if (SELF_PROCESSES.has(p.name)) return false;
    if (safeList.includes(p.name)) return false;
    return true;
  });

  return {
    apps: quittable,
    safeList,
    memSummary: getMemorySummary(),
  };
}
