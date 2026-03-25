/**
 * process-manager.ts
 *
 * Start, stop, restart background processes. Track PIDs, health-check,
 * stream log output. Zero external dependencies - Node/Bun built-ins only.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, createWriteStream, type WriteStream } from "node:fs";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type ProcessStatus = "running" | "stopped" | "crashed" | "unknown";

export interface ProcessConfig {
  name: string;
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  healthIntervalMs?: number;
  maxLogLines?: number;
  persistLog?: boolean;
  killTimeoutMs?: number;
}

export interface ProcessRecord {
  name: string;
  pid: number;
  status: ProcessStatus;
  startedAt: number;
  stoppedAt?: number;
  exitCode?: number | null;
  restarts: number;
  logLines: string[];
}

export interface StartResult {
  name: string;
  pid: number;
  status: "started" | "already-running";
}

export interface StopResult {
  name: string;
  status: "stopped" | "not-found" | "already-stopped";
  exitCode?: number | null;
}

export interface RestartResult {
  name: string;
  pid: number;
  restarts: number;
}

export interface HealthResult {
  name: string;
  status: ProcessStatus;
  pid?: number;
  uptime?: number;
  pidAlive: boolean;
}

export class ProcessManager {
  private records = new Map<string, ProcessRecord>();
  private handles = new Map<string, ChildProcess>();
  private logStreams = new Map<string, WriteStream>();
  private healthTimers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly logDir: string;

  constructor(logDir?: string) {
    this.logDir = logDir ?? join(homedir(), ".8gent", "process-logs");
  }

  async start(config: ProcessConfig): Promise<StartResult> {
    const existing = this.records.get(config.name);
    if (existing && existing.status === "running") {
      return { name: config.name, pid: existing.pid, status: "already-running" };
    }

    const [cmd, ...args] = config.command;
    if (!cmd) throw new Error(`process-manager: command array is empty for "${config.name}"`);

    const child = spawn(cmd, args, {
      cwd: config.cwd ?? process.cwd(),
      env: { ...process.env, ...(config.env ?? {}) },
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (child.pid === undefined) {
      throw new Error(`process-manager: failed to spawn "${config.name}" - pid undefined`);
    }

    const maxLines = config.maxLogLines ?? 500;
    const record: ProcessRecord = {
      name: config.name,
      pid: child.pid,
      status: "running",
      startedAt: Date.now(),
      restarts: existing?.restarts ?? 0,
      logLines: [],
    };

    this.records.set(config.name, record);
    this.handles.set(config.name, child);

    if (config.persistLog) {
      this.ensureLogDir();
      const ws = createWriteStream(join(this.logDir, `${config.name}.log`), { flags: "a" });
      this.logStreams.set(config.name, ws);
    }

    const appendLog = (line: string): void => {
      const ts = new Date().toISOString();
      const entry = `[${ts}] ${line}`;
      record.logLines.push(entry);
      if (record.logLines.length > maxLines) record.logLines.shift();
      this.logStreams.get(config.name)?.write(entry + "\n");
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (line.trim()) appendLog(`stdout: ${line}`);
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (line.trim()) appendLog(`stderr: ${line}`);
      }
    });

    child.on("exit", (code, signal) => {
      const rec = this.records.get(config.name);
      if (rec) {
        rec.status = code === 0 ? "stopped" : "crashed";
        rec.exitCode = code;
        rec.stoppedAt = Date.now();
        appendLog(`exit code=${code ?? signal ?? "?"}`);
      }
      this.logStreams.get(config.name)?.end();
      this.logStreams.delete(config.name);
      this.handles.delete(config.name);
    });

    const intervalMs = config.healthIntervalMs ?? 5000;
    const timer = setInterval(() => {
      const rec = this.records.get(config.name);
      if (!rec || rec.status !== "running") {
        clearInterval(timer);
        this.healthTimers.delete(config.name);
        return;
      }
      if (!pidAlive(rec.pid)) {
        rec.status = "crashed";
        rec.stoppedAt = Date.now();
        clearInterval(timer);
        this.healthTimers.delete(config.name);
      }
    }, intervalMs);

    this.healthTimers.set(config.name, timer);

    return { name: config.name, pid: child.pid, status: "started" };
  }

  async stop(name: string, killTimeoutMs = 5000): Promise<StopResult> {
    const record = this.records.get(name);
    if (!record) return { name, status: "not-found" };
    if (record.status !== "running") {
      return { name, status: "already-stopped", exitCode: record.exitCode };
    }

    const child = this.handles.get(name);
    if (!child) return { name, status: "already-stopped" };

    return new Promise((resolve) => {
      let settled = false;

      child.once("exit", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        record.status = "stopped";
        record.exitCode = code;
        record.stoppedAt = Date.now();
        this.handles.delete(name);
        resolve({ name, status: "stopped", exitCode: code });
      });

      try { child.kill("SIGTERM"); } catch { /* already gone */ }

      const killTimer = setTimeout(() => {
        if (settled) return;
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
        setTimeout(() => {
          if (settled) return;
          settled = true;
          record.status = "stopped";
          record.stoppedAt = Date.now();
          this.handles.delete(name);
          resolve({ name, status: "stopped", exitCode: null });
        }, 500);
      }, killTimeoutMs);
    });
  }

  async restart(config: ProcessConfig): Promise<RestartResult> {
    const previous = this.records.get(config.name);
    if (previous && previous.status === "running") {
      await this.stop(config.name, config.killTimeoutMs);
    }
    const result = await this.start(config);
    const updated = this.records.get(config.name)!;
    updated.restarts = (previous?.restarts ?? 0) + 1;
    return { name: result.name, pid: result.pid, restarts: updated.restarts };
  }

  health(name: string): HealthResult {
    const record = this.records.get(name);
    if (!record) return { name, status: "unknown", pidAlive: false };

    const alive = record.status === "running" ? pidAlive(record.pid) : false;
    if (record.status === "running" && !alive) {
      record.status = "crashed";
      record.stoppedAt = Date.now();
    }

    const uptime = record.stoppedAt
      ? record.stoppedAt - record.startedAt
      : Date.now() - record.startedAt;

    return { name, status: record.status, pid: record.pid, uptime, pidAlive: alive };
  }

  list(): ProcessRecord[] {
    return Array.from(this.records.values());
  }

  get(name: string): ProcessRecord | undefined {
    return this.records.get(name);
  }

  logs(name: string, tail?: number): string[] {
    const record = this.records.get(name);
    if (!record) return [];
    return tail ? record.logLines.slice(-tail) : [...record.logLines];
  }

  savePidFile(name: string): void {
    const rec = this.records.get(name);
    if (!rec) throw new Error(`process-manager: no record for "${name}"`);
    this.ensureLogDir();
    writeFileSync(join(this.logDir, `${name}.pid`), String(rec.pid), "utf8");
  }

  loadPidFile(name: string): number | null {
    const path = join(this.logDir, `${name}.pid`);
    if (!existsSync(path)) return null;
    const pid = parseInt(readFileSync(path, "utf8").trim(), 10);
    return isNaN(pid) ? null : pid;
  }

  async stopAll(): Promise<StopResult[]> {
    const running = Array.from(this.records.keys()).filter(
      (n) => this.records.get(n)?.status === "running"
    );
    return Promise.all(running.map((n) => this.stop(n)));
  }

  dispose(): void {
    for (const timer of this.healthTimers.values()) clearInterval(timer);
    this.healthTimers.clear();
    for (const ws of this.logStreams.values()) ws.end();
    this.logStreams.clear();
  }

  private ensureLogDir(): void {
    if (!existsSync(this.logDir)) mkdirSync(this.logDir, { recursive: true });
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);

  const usage = `Usage:
  bun packages/tools/process-manager.ts start  <name> <cmd> [args...]
  bun packages/tools/process-manager.ts stop   <name>
  bun packages/tools/process-manager.ts health <name>
  bun packages/tools/process-manager.ts logs   <name> [--tail=N]
  bun packages/tools/process-manager.ts list

Examples:
  bun packages/tools/process-manager.ts start my-server node server.js
  bun packages/tools/process-manager.ts health my-server
  bun packages/tools/process-manager.ts logs my-server --tail=50
  bun packages/tools/process-manager.ts stop my-server`.trim();

  const cmd = args[0];

  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(usage);
    process.exit(0);
  }

  const pm = new ProcessManager();

  if (cmd === "start") {
    const name = args[1];
    const command = args.slice(2);
    if (!name || command.length === 0) {
      console.error("error: start requires <name> and <cmd> [args...]");
      process.exit(1);
    }
    const result = await pm.start({ name, command });
    console.log(result.status === "already-running"
      ? `${name}  already-running  pid=${result.pid}`
      : `${name}  started  pid=${result.pid}`);
    pm.dispose();

  } else if (cmd === "stop") {
    const name = args[1];
    if (!name) { console.error("error: stop requires <name>"); process.exit(1); }
    const result = await pm.stop(name);
    console.log(`${name}  ${result.status}  exitCode=${result.exitCode ?? "?"}`);
    pm.dispose();

  } else if (cmd === "health") {
    const name = args[1];
    if (!name) { console.error("error: health requires <name>"); process.exit(1); }
    const h = pm.health(name);
    const uptimeStr = h.uptime != null ? `${Math.round(h.uptime / 1000)}s` : "-";
    console.log(`${h.name}  status=${h.status}  pid=${h.pid ?? "-"}  uptime=${uptimeStr}  pidAlive=${h.pidAlive}`);
    pm.dispose();

  } else if (cmd === "logs") {
    const name = args[1];
    if (!name) { console.error("error: logs requires <name>"); process.exit(1); }
    const tailArg = args.find((a) => a.startsWith("--tail="));
    const tail = tailArg ? parseInt(tailArg.split("=")[1]!, 10) : undefined;
    const lines = pm.logs(name, tail);
    if (lines.length === 0) {
      console.log(`no log lines for "${name}"`);
    } else {
      for (const line of lines) console.log(line);
    }
    pm.dispose();

  } else if (cmd === "list") {
    const all = pm.list();
    if (all.length === 0) {
      console.log("no processes tracked");
    } else {
      console.log(`${"NAME".padEnd(20)} ${"PID".padEnd(8)} ${"STATUS".padEnd(12)} RESTARTS`);
      for (const r of all) {
        console.log(`${r.name.padEnd(20)} ${String(r.pid).padEnd(8)} ${r.status.padEnd(12)} ${r.restarts}`);
      }
    }
    pm.dispose();

  } else {
    console.error(`unknown command: ${cmd}\n`);
    console.log(usage);
    process.exit(1);
  }
}
