/**
 * Structured JSON logger with log levels, context binding, child loggers, and timestamps.
 * Zero external dependencies. Suitable for agent observability and daemon processes.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context: Record<string, unknown>;
  [key: string]: unknown;
}

export interface LoggerOptions {
  level?: LogLevel;
  context?: Record<string, unknown>;
  output?: (entry: LogEntry) => void;
}

export class Logger {
  private minLevel: LogLevel;
  private context: Record<string, unknown>;
  private output: (entry: LogEntry) => void;

  constructor(options: LoggerOptions = {}) {
    this.minLevel = options.level ?? "info";
    this.context = { ...(options.context ?? {}) };
    this.output = options.output ?? ((entry) => process.stdout.write(JSON.stringify(entry) + "\n"));
  }

  private write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.minLevel]) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context: { ...this.context, ...(fields ?? {}) },
    };

    this.output(entry);
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.write("debug", message, fields);
  }

  info(message: string, fields?: Record<string, unknown>): void {
    this.write("info", message, fields);
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.write("warn", message, fields);
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.write("error", message, fields);
  }

  /** Bind additional context fields. Returns a new logger - does not mutate the parent. */
  withContext(fields: Record<string, unknown>): Logger {
    return new Logger({
      level: this.minLevel,
      context: { ...this.context, ...fields },
      output: this.output,
    });
  }

  /** Create a child logger with a named scope. Inherits parent context, level, and output sink. */
  child(scope: string, extra?: Record<string, unknown>): Logger {
    return this.withContext({ scope, ...(extra ?? {}) });
  }

  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  getLevel(): LogLevel {
    return this.minLevel;
  }

  getContext(): Record<string, unknown> {
    return { ...this.context };
  }
}

/** Default process-level logger. */
export const logger = new Logger({ level: "info" });

// CLI smoke test
if (import.meta.main) {
  const root = new Logger({ level: "debug", context: { app: "8gent", version: "1.0.0" } });
  root.debug("debug message", { detail: "verbose trace" });
  root.info("agent started");
  root.warn("memory usage high", { usedMb: 512 });
  root.error("tool execution failed", { tool: "bash", code: 1 });

  const child = root.child("orchestration", { worktree: "wt-1" });
  child.info("worktree spawned");

  const grandchild = child.child("file-watcher");
  grandchild.debug("watching path", { path: "/tmp/work" });
  grandchild.warn("file changed during lock", { file: "agent.ts" });
}
