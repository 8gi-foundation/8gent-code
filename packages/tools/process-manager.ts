/**
 * Process Manager - spawn, monitor, restart, and kill child processes.
 * Used by daemon and background tasks in the 8gent ecosystem.
 */

import { spawn, type Subprocess } from "bun";

export interface ProcessConfig {
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  restartOnCrash?: boolean;
  maxRestarts?: number;
  restartDelayMs?: number;
  onStdout?: (line: string) => void;
  onStderr?: (line: string) => void;
  onExit?: (code: number | null, id: string) => void;
}

interface ManagedProcess {
  id: string;
  config: ProcessConfig;
  proc: Subprocess | null;
  restarts: number;
  running: boolean;
  logs: string[];
}

const MAX_LOG_LINES = 500;

export class ProcessManager {
  private processes = new Map<string, ManagedProcess>();

  /** Spawn a managed child process. Returns a unique ID. */
  spawn(id: string, config: ProcessConfig): string {
    if (this.processes.has(id)) {
      throw new Error(`Process "${id}" already exists. Kill it first.`);
    }

    const managed: ManagedProcess = {
      id,
      config,
      proc: null,
      restarts: 0,
      running: false,
      logs: [],
    };

    this.processes.set(id, managed);
    this.startProcess(managed);
    return id;
  }

  private startProcess(managed: ManagedProcess): void {
    const { config } = managed;
    const [cmd, ...args] = config.command;

    const proc = spawn({
      cmd: [cmd, ...args],
      cwd: config.cwd,
      env: { ...process.env, ...config.env },
      stdout: "pipe",
      stderr: "pipe",
    });

    managed.proc = proc;
    managed.running = true;

    // Stream stdout
    if (proc.stdout) {
      this.pipeStream(proc.stdout, (line) => {
        this.appendLog(managed, `[out] ${line}`);
        config.onStdout?.(line);
      });
    }

    // Stream stderr
    if (proc.stderr) {
      this.pipeStream(proc.stderr, (line) => {
        this.appendLog(managed, `[err] ${line}`);
        config.onStderr?.(line);
      });
    }

    // Handle exit
    proc.exited.then((code) => {
      managed.running = false;
      this.appendLog(managed, `[sys] exited with code ${code}`);
      config.onExit?.(code, managed.id);

      const maxRestarts = config.maxRestarts ?? 3;
      if (config.restartOnCrash && code !== 0 && managed.restarts < maxRestarts) {
        managed.restarts++;
        const delay = config.restartDelayMs ?? 1000;
        this.appendLog(managed, `[sys] restarting in ${delay}ms (attempt ${managed.restarts}/${maxRestarts})`);
        setTimeout(() => this.startProcess(managed), delay);
      }
    });
  }

  private async pipeStream(stream: ReadableStream<Uint8Array>, handler: (line: string) => void): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) handler(line);
      }
      if (buffer) handler(buffer);
    } catch {
      // Stream closed - expected on kill
    }
  }

  private appendLog(managed: ManagedProcess, line: string): void {
    managed.logs.push(line);
    if (managed.logs.length > MAX_LOG_LINES) {
      managed.logs.splice(0, managed.logs.length - MAX_LOG_LINES);
    }
  }

  /** Kill a process gracefully (SIGTERM), then force (SIGKILL) after timeout. */
  async kill(id: string, timeoutMs = 5000): Promise<boolean> {
    const managed = this.processes.get(id);
    if (!managed?.proc || !managed.running) return false;

    // Disable restart-on-crash for intentional kills
    managed.config.restartOnCrash = false;
    managed.proc.kill("SIGTERM");

    const exited = await Promise.race([
      managed.proc.exited.then(() => true),
      new Promise<false>((r) => setTimeout(() => r(false), timeoutMs)),
    ]);

    if (!exited && managed.proc) {
      managed.proc.kill("SIGKILL");
      await managed.proc.exited;
    }

    this.processes.delete(id);
    return true;
  }

  /** Kill all managed processes. */
  async killAll(): Promise<void> {
    const ids = [...this.processes.keys()];
    await Promise.all(ids.map((id) => this.kill(id)));
  }

  /** Get status of a process. */
  status(id: string): { running: boolean; restarts: number; logs: string[] } | null {
    const managed = this.processes.get(id);
    if (!managed) return null;
    return { running: managed.running, restarts: managed.restarts, logs: [...managed.logs] };
  }

  /** List all managed process IDs with their running state. */
  list(): Array<{ id: string; running: boolean; restarts: number }> {
    return [...this.processes.values()].map((m) => ({
      id: m.id,
      running: m.running,
      restarts: m.restarts,
    }));
  }
}
