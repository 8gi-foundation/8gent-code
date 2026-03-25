import { spawn as nodeSpawn, ChildProcess } from "node:child_process";

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  autoRestart?: boolean;
  maxRestarts?: number;
  restartDelayMs?: number;
  maxLogLines?: number;
}

interface ManagedProcess {
  name: string;
  cmd: string;
  args: string[];
  options: SpawnOptions;
  proc: ChildProcess | null;
  pid: number | null;
  restarts: number;
  startedAt: Date | null;
  stoppedAt: Date | null;
  logs: string[];
  status: "running" | "stopped" | "crashed" | "restarting";
}

export class ProcessManager {
  private processes = new Map<string, ManagedProcess>();
  private restartTimers = new Map<string, ReturnType<typeof setTimeout>>();

  spawn(name: string, cmd: string, args: string[] = [], options: SpawnOptions = {}): void {
    if (this.processes.has(name)) {
      throw new Error(`Process "${name}" already exists. Stop it first or use restart().`);
    }

    const entry: ManagedProcess = {
      name,
      cmd,
      args,
      options: {
        autoRestart: false,
        maxRestarts: 5,
        restartDelayMs: 1000,
        maxLogLines: 200,
        ...options,
      },
      proc: null,
      pid: null,
      restarts: 0,
      startedAt: null,
      stoppedAt: null,
      logs: [],
      status: "stopped",
    };

    this.processes.set(name, entry);
    this._start(name);
  }

  private _start(name: string): void {
    const entry = this.processes.get(name);
    if (!entry) return;

    const proc = nodeSpawn(entry.cmd, entry.args, {
      cwd: entry.options.cwd,
      env: { ...process.env, ...(entry.options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    entry.proc = proc;
    entry.pid = proc.pid ?? null;
    entry.startedAt = new Date();
    entry.status = "running";

    const appendLog = (line: string) => {
      entry.logs.push(`[${new Date().toISOString()}] ${line}`);
      const max = entry.options.maxLogLines ?? 200;
      if (entry.logs.length > max) entry.logs.splice(0, entry.logs.length - max);
    };

    proc.stdout?.on("data", (chunk) => {
      String(chunk).split("\n").filter(Boolean).forEach(appendLog);
    });

    proc.stderr?.on("data", (chunk) => {
      String(chunk).split("\n").filter(Boolean).forEach((l) => appendLog(`[stderr] ${l}`));
    });

    proc.on("exit", (code, signal) => {
      entry.stoppedAt = new Date();
      const crashed = code !== 0 && signal == null;
      entry.status = crashed ? "crashed" : "stopped";
      entry.proc = null;
      entry.pid = null;
      appendLog(`Process exited (code=${code}, signal=${signal})`);

      if (crashed && entry.options.autoRestart) {
        const maxRestarts = entry.options.maxRestarts ?? 5;
        if (entry.restarts < maxRestarts) {
          entry.restarts++;
          entry.status = "restarting";
          appendLog(`Auto-restarting (attempt ${entry.restarts}/${maxRestarts})`);
          const timer = setTimeout(() => {
            this.restartTimers.delete(name);
            this._start(name);
          }, entry.options.restartDelayMs ?? 1000);
          this.restartTimers.set(name, timer);
        } else {
          appendLog(`Max restarts (${maxRestarts}) reached. Giving up.`);
        }
      }
    });
  }

  stop(name: string): void {
    const entry = this.processes.get(name);
    if (!entry) throw new Error(`Unknown process: "${name}"`);

    const timer = this.restartTimers.get(name);
    if (timer) {
      clearTimeout(timer);
      this.restartTimers.delete(name);
    }

    // Disable auto-restart before killing so exit handler won't re-launch.
    entry.options.autoRestart = false;

    if (entry.proc) {
      entry.proc.kill("SIGTERM");
    }

    this.processes.delete(name);
  }

  restart(name: string): void {
    const entry = this.processes.get(name);
    if (!entry) throw new Error(`Unknown process: "${name}"`);

    if (entry.proc) entry.proc.kill("SIGTERM");

    // Give it a moment, then start fresh.
    setTimeout(() => this._start(name), 200);
  }

  health(name: string): { status: string; pid: number | null; restarts: number; uptime: number | null } {
    const entry = this.processes.get(name);
    if (!entry) throw new Error(`Unknown process: "${name}"`);

    const uptime =
      entry.startedAt && entry.status === "running"
        ? Date.now() - entry.startedAt.getTime()
        : null;

    return { status: entry.status, pid: entry.pid, restarts: entry.restarts, uptime };
  }

  logs(name: string, lines?: number): string[] {
    const entry = this.processes.get(name);
    if (!entry) throw new Error(`Unknown process: "${name}"`);
    return lines != null ? entry.logs.slice(-lines) : [...entry.logs];
  }

  listAll(): Array<{ name: string; status: string; pid: number | null; restarts: number }> {
    return Array.from(this.processes.values()).map((e) => ({
      name: e.name,
      status: e.status,
      pid: e.pid,
      restarts: e.restarts,
    }));
  }

  stopAll(): void {
    for (const name of [...this.processes.keys()]) {
      try {
        this.stop(name);
      } catch {
        // ignore individual errors during bulk stop
      }
    }
  }
}
