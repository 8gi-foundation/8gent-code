/**
 * 8gent Code - Background Task Manager
 *
 * Run commands in the background and retrieve their status/output later.
 */

import { spawn, ChildProcess } from "child_process";
import * as path from "path";

// ============================================
// Types
// ============================================

export type TaskStatus = "running" | "completed" | "failed" | "killed";

export interface BackgroundTask {
  id: string;
  command: string;
  status: TaskStatus;
  process: ChildProcess | null;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  startedAt: Date;
  endedAt: Date | null;
  workingDirectory: string;
}

export interface TaskInfo {
  id: string;
  command: string;
  status: TaskStatus;
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
  runtime: number; // milliseconds
  outputLength: number;
  errorLength: number;
}

export interface TaskOutput {
  id: string;
  stdout: string;
  stderr: string;
  combined: string;
}

// ============================================
// Background Task Manager
// ============================================

export class BackgroundTaskManager {
  private tasks: Map<string, BackgroundTask> = new Map();
  private taskCounter: number = 0;
  private maxOutputSize: number = 1024 * 1024; // 1MB per task

  constructor(private defaultWorkingDirectory: string = process.cwd()) {}

  /**
   * Generate a unique task ID
   */
  private generateTaskId(): string {
    return `task_${Date.now()}_${++this.taskCounter}`;
  }

  /**
   * Start a command in the background
   */
  startTask(
    command: string,
    options: {
      workingDirectory?: string;
      env?: Record<string, string>;
      timeout?: number;
    } = {}
  ): string {
    const id = this.generateTaskId();
    const workingDirectory = options.workingDirectory || this.defaultWorkingDirectory;

    const task: BackgroundTask = {
      id,
      command,
      status: "running",
      process: null,
      stdout: "",
      stderr: "",
      exitCode: null,
      startedAt: new Date(),
      endedAt: null,
      workingDirectory,
    };

    // Spawn the process
    const proc = spawn("sh", ["-c", command], {
      cwd: workingDirectory,
      env: {
        ...process.env,
        ...options.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    task.process = proc;
    this.tasks.set(id, task);

    // Capture stdout
    proc.stdout.on("data", (data) => {
      const str = data.toString();
      if (task.stdout.length + str.length <= this.maxOutputSize) {
        task.stdout += str;
      } else {
        // Truncate if too large
        const remaining = this.maxOutputSize - task.stdout.length;
        if (remaining > 0) {
          task.stdout += str.slice(0, remaining);
          task.stdout += "\n[Output truncated - max size reached]";
        }
      }
    });

    // Capture stderr
    proc.stderr.on("data", (data) => {
      const str = data.toString();
      if (task.stderr.length + str.length <= this.maxOutputSize) {
        task.stderr += str;
      } else {
        const remaining = this.maxOutputSize - task.stderr.length;
        if (remaining > 0) {
          task.stderr += str.slice(0, remaining);
          task.stderr += "\n[Error output truncated - max size reached]";
        }
      }
    });

    // Handle process completion
    proc.on("close", (code, signal) => {
      task.exitCode = code;
      task.endedAt = new Date();
      task.process = null;

      if (signal === "SIGTERM" || signal === "SIGKILL") {
        task.status = "killed";
      } else if (code === 0) {
        task.status = "completed";
      } else {
        task.status = "failed";
      }
    });

    proc.on("error", (err) => {
      task.status = "failed";
      task.stderr += `\nProcess error: ${err.message}`;
      task.endedAt = new Date();
      task.process = null;
    });

    // Optional timeout
    if (options.timeout && options.timeout > 0) {
      setTimeout(() => {
        if (task.status === "running") {
          this.killTask(id);
          task.stderr += `\n[Task killed - timeout after ${options.timeout}ms]`;
        }
      }, options.timeout);
    }

    console.log(`[background] Started task ${id}: ${command.slice(0, 50)}...`);
    return id;
  }

  /**
   * Adopt an already-running ChildProcess as a background task.
   * Used when run_command detects a long-running process and promotes it.
   */
  adoptProcess(
    command: string,
    proc: ChildProcess,
    existingStdout: string = "",
    existingStderr: string = "",
  ): string {
    const id = this.generateTaskId();

    const task: BackgroundTask = {
      id,
      command,
      status: "running",
      process: proc,
      stdout: existingStdout,
      stderr: existingStderr,
      exitCode: null,
      startedAt: new Date(),
      endedAt: null,
      workingDirectory: this.defaultWorkingDirectory,
    };

    this.tasks.set(id, task);

    // Re-wire stdio capture (listeners from run_command are still attached,
    // but they write to local vars that are now abandoned — we add our own)
    proc.stdout?.on("data", (data) => {
      const str = data.toString();
      if (task.stdout.length + str.length <= this.maxOutputSize) {
        task.stdout += str;
      }
    });

    proc.stderr?.on("data", (data) => {
      const str = data.toString();
      if (task.stderr.length + str.length <= this.maxOutputSize) {
        task.stderr += str;
      }
    });

    proc.on("close", (code, signal) => {
      task.exitCode = code;
      task.endedAt = new Date();
      task.process = null;
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        task.status = "killed";
      } else if (code === 0) {
        task.status = "completed";
      } else {
        task.status = "failed";
      }
    });

    proc.on("error", (err) => {
      task.status = "failed";
      task.stderr += `\nProcess error: ${err.message}`;
      task.endedAt = new Date();
      task.process = null;
    });

    console.log(`[background] Adopted running process as task ${id}: ${command.slice(0, 50)}...`);
    return id;
  }

  /**
   * Get the status of a task
   */
  getTaskStatus(taskId: string): TaskInfo | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    const now = new Date();
    const endTime = task.endedAt || now;
    const runtime = endTime.getTime() - task.startedAt.getTime();

    return {
      id: task.id,
      command: task.command,
      status: task.status,
      exitCode: task.exitCode,
      startedAt: task.startedAt.toISOString(),
      endedAt: task.endedAt?.toISOString() || null,
      runtime,
      outputLength: task.stdout.length,
      errorLength: task.stderr.length,
    };
  }

  /**
   * Get the output of a task
   */
  getTaskOutput(
    taskId: string,
    options: {
      tail?: number;
      stdout?: boolean;
      stderr?: boolean;
    } = {}
  ): TaskOutput | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    let stdout = task.stdout;
    let stderr = task.stderr;

    // Optionally get only last N lines
    if (options.tail && options.tail > 0) {
      const tailLines = (text: string, n: number): string => {
        const lines = text.split("\n");
        return lines.slice(-n).join("\n");
      };
      stdout = tailLines(stdout, options.tail);
      stderr = tailLines(stderr, options.tail);
    }

    // Filter by stream type
    if (options.stdout === false) stdout = "";
    if (options.stderr === false) stderr = "";

    // Combined output (interleaved is not possible, so just concatenate)
    const combined = stdout + (stderr ? "\n--- STDERR ---\n" + stderr : "");

    return {
      id: taskId,
      stdout,
      stderr,
      combined,
    };
  }

  /**
   * Kill a running task
   */
  killTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || !task.process) return false;

    try {
      task.process.kill("SIGTERM");

      // Force kill after 5 seconds if still running
      setTimeout(() => {
        if (task.status === "running" && task.process) {
          task.process.kill("SIGKILL");
        }
      }, 5000);

      return true;
    } catch {
      return false;
    }
  }

  /**
   * List all tasks
   */
  listTasks(options: { status?: TaskStatus; limit?: number } = {}): TaskInfo[] {
    let tasks = Array.from(this.tasks.values());

    if (options.status) {
      tasks = tasks.filter(t => t.status === options.status);
    }

    // Sort by start time (newest first)
    tasks.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

    if (options.limit && options.limit > 0) {
      tasks = tasks.slice(0, options.limit);
    }

    return tasks.map(task => {
      const now = new Date();
      const endTime = task.endedAt || now;
      const runtime = endTime.getTime() - task.startedAt.getTime();

      return {
        id: task.id,
        command: task.command,
        status: task.status,
        exitCode: task.exitCode,
        startedAt: task.startedAt.toISOString(),
        endedAt: task.endedAt?.toISOString() || null,
        runtime,
        outputLength: task.stdout.length,
        errorLength: task.stderr.length,
      };
    });
  }

  /**
   * Wait for a task to complete
   */
  async waitForTask(taskId: string, timeout: number = 60000): Promise<TaskInfo | null> {
    const startTime = Date.now();

    return new Promise((resolve) => {
      const check = () => {
        const task = this.tasks.get(taskId);
        if (!task) {
          resolve(null);
          return;
        }

        if (task.status !== "running") {
          resolve(this.getTaskStatus(taskId));
          return;
        }

        if (Date.now() - startTime > timeout) {
          resolve(this.getTaskStatus(taskId));
          return;
        }

        setTimeout(check, 100);
      };

      check();
    });
  }

  /**
   * Clear completed/failed tasks from memory
   */
  clearFinishedTasks(): number {
    let cleared = 0;
    for (const [id, task] of this.tasks) {
      if (task.status !== "running") {
        this.tasks.delete(id);
        cleared++;
      }
    }
    return cleared;
  }

  /**
   * Clear a specific task
   */
  clearTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    if (task.status === "running") {
      this.killTask(taskId);
    }

    this.tasks.delete(taskId);
    return true;
  }

  /**
   * Get count of tasks by status
   */
  getTaskCounts(): Record<TaskStatus, number> {
    const counts: Record<TaskStatus, number> = {
      running: 0,
      completed: 0,
      failed: 0,
      killed: 0,
    };

    for (const task of this.tasks.values()) {
      counts[task.status]++;
    }

    return counts;
  }

  /**
   * Kill all running tasks
   */
  killAllTasks(): number {
    let killed = 0;
    for (const task of this.tasks.values()) {
      if (task.status === "running") {
        this.killTask(task.id);
        killed++;
      }
    }
    return killed;
  }

  /**
   * Set the default working directory
   */
  setDefaultWorkingDirectory(dir: string): void {
    this.defaultWorkingDirectory = dir;
  }
}

// ============================================
// Singleton Instance
// ============================================

let taskManagerInstance: BackgroundTaskManager | null = null;

export function getBackgroundTaskManager(workingDirectory?: string): BackgroundTaskManager {
  if (!taskManagerInstance) {
    taskManagerInstance = new BackgroundTaskManager(workingDirectory);
  } else if (workingDirectory) {
    taskManagerInstance.setDefaultWorkingDirectory(workingDirectory);
  }
  return taskManagerInstance;
}

export function resetBackgroundTaskManager(): void {
  if (taskManagerInstance) {
    taskManagerInstance.killAllTasks();
    taskManagerInstance = null;
  }
}

// ============================================
// Helper Functions
// ============================================

/**
 * Format task status for display
 */
export function formatTaskStatus(info: TaskInfo): string {
  const statusEmoji: Record<TaskStatus, string> = {
    running: "...",
    completed: "[done]",
    failed: "[fail]",
    killed: "[kill]",
  };

  const runtime = info.runtime < 1000
    ? `${info.runtime}ms`
    : info.runtime < 60000
    ? `${(info.runtime / 1000).toFixed(1)}s`
    : `${(info.runtime / 60000).toFixed(1)}m`;

  return `${statusEmoji[info.status]} ${info.id}: ${info.command.slice(0, 40)}${info.command.length > 40 ? "..." : ""} (${runtime})`;
}

/**
 * Format task output for display
 */
export function formatTaskOutput(output: TaskOutput, task: TaskInfo): string {
  let result = `# Task: ${task.id}\n`;
  result += `Command: ${task.command}\n`;
  result += `Status: ${task.status}`;

  if (task.exitCode !== null) {
    result += ` (exit code: ${task.exitCode})`;
  }

  result += "\n\n";

  if (output.stdout) {
    result += "## stdout\n```\n" + output.stdout + "\n```\n\n";
  }

  if (output.stderr) {
    result += "## stderr\n```\n" + output.stderr + "\n```\n";
  }

  return result;
}
