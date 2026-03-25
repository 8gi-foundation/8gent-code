import os from "os";

export interface ResourceUsage {
  pid: number;
  memoryMb: number;
  cpuPercent: number;
  timestamp: number;
}

interface LimitConfig {
  memoryMb: number;
  cpuPercent: number;
}

interface CpuSnapshot {
  idle: number;
  total: number;
}

function cpuSnapshot(): CpuSnapshot {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    for (const [key, val] of Object.entries(cpu.times)) {
      total += val;
      if (key === "idle") idle += val;
    }
  }
  return { idle, total };
}

export class ResourceLimiter {
  private limits: LimitConfig = { memoryMb: Infinity, cpuPercent: 100 };
  private usageHistory = new Map<number, ResourceUsage[]>();
  private cpuBaseline: CpuSnapshot | null = null;

  setMemoryLimit(mb: number): void {
    if (mb <= 0) throw new Error("Memory limit must be positive");
    this.limits.memoryMb = mb;
  }

  setCpuLimit(percent: number): void {
    if (percent <= 0 || percent > 100)
      throw new Error("CPU limit must be between 1 and 100");
    this.limits.cpuPercent = percent;
  }

  monitor(pid: number): ResourceUsage {
    // Collect current process memory via /proc or process.memoryUsage() for self
    let memoryMb = 0;

    if (pid === process.pid) {
      const mem = process.memoryUsage();
      memoryMb = mem.rss / 1024 / 1024;
    } else {
      // Best-effort: read from /proc on Linux
      try {
        const fs = require("fs") as typeof import("fs");
        const statm = fs.readFileSync(`/proc/${pid}/statm`, "utf8");
        const pages = parseInt(statm.split(" ")[1], 10);
        const pageSize = 4096; // bytes
        memoryMb = (pages * pageSize) / 1024 / 1024;
      } catch {
        // /proc not available (macOS/Windows) - estimate as 0
        memoryMb = 0;
      }
    }

    // CPU: delta between snapshots
    const now = cpuSnapshot();
    let cpuPercent = 0;
    if (this.cpuBaseline) {
      const idleDelta = now.idle - this.cpuBaseline.idle;
      const totalDelta = now.total - this.cpuBaseline.total;
      cpuPercent =
        totalDelta > 0
          ? Math.max(0, 100 * (1 - idleDelta / totalDelta))
          : 0;
    }
    this.cpuBaseline = now;

    const usage: ResourceUsage = {
      pid,
      memoryMb: parseFloat(memoryMb.toFixed(2)),
      cpuPercent: parseFloat(cpuPercent.toFixed(2)),
      timestamp: Date.now(),
    };

    const history = this.usageHistory.get(pid) ?? [];
    history.push(usage);
    // Keep last 60 samples
    if (history.length > 60) history.shift();
    this.usageHistory.set(pid, history);

    return usage;
  }

  getUsage(pid: number): ResourceUsage | null {
    const history = this.usageHistory.get(pid);
    return history?.at(-1) ?? null;
  }

  isOverLimit(pid: number): boolean {
    const usage = this.getUsage(pid);
    if (!usage) return false;
    return (
      usage.memoryMb > this.limits.memoryMb ||
      usage.cpuPercent > this.limits.cpuPercent
    );
  }

  kill(pid: number): boolean {
    try {
      process.kill(pid, "SIGKILL");
      this.usageHistory.delete(pid);
      return true;
    } catch {
      return false;
    }
  }

  getLimits(): Readonly<LimitConfig> {
    return { ...this.limits };
  }

  clearHistory(pid: number): void {
    this.usageHistory.delete(pid);
  }
}
