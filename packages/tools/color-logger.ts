/**
 * color-logger - terminal logger with automatic level-based ANSI coloring,
 * namespace support, level filtering, and TTY auto-detection.
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "success";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  success: 2,
  warn: 3,
  error: 4,
};

// ANSI escape helpers - no deps
const ansi = (code: string) => `\x1b[${code}m`;
const RESET = ansi("0");
const DIM = ansi("2");
const CYAN = ansi("36");
const YELLOW = ansi("33");
const RED = ansi("31");
const GREEN = ansi("32");
const BOLD = ansi("1");

const LEVEL_STYLE: Record<LogLevel, { label: string; color: string }> = {
  debug:   { label: "DBG", color: DIM },
  info:    { label: "INF", color: CYAN },
  warn:    { label: "WRN", color: YELLOW },
  error:   { label: "ERR", color: RED },
  success: { label: "OK ", color: GREEN },
};

export interface ColorLoggerOptions {
  /** Minimum level to emit. Defaults to "debug". */
  minLevel?: LogLevel;
  /** Optional namespace prefix shown in brackets. */
  namespace?: string;
  /** Override TTY detection. When false, ANSI codes are stripped. */
  tty?: boolean;
  /** Custom output function. Defaults to process.stderr.write. */
  output?: (line: string) => void;
  /** Include timestamp prefix. Defaults to true. */
  timestamps?: boolean;
}

export class ColorLogger {
  private minLevel: LogLevel;
  private namespace: string | undefined;
  private tty: boolean;
  private output: (line: string) => void;
  private timestamps: boolean;

  constructor(options: ColorLoggerOptions = {}) {
    this.minLevel = options.minLevel ?? "debug";
    this.namespace = options.namespace;
    this.timestamps = options.timestamps ?? true;
    this.output = options.output ?? ((line) => process.stderr.write(line + "\n"));

    // Auto-detect TTY: check if stderr is a terminal
    if (options.tty !== undefined) {
      this.tty = options.tty;
    } else {
      this.tty = Boolean(
        typeof process !== "undefined" &&
        process.stderr &&
        (process.stderr as NodeJS.WriteStream).isTTY
      );
    }
  }

  private shouldEmit(level: LogLevel): boolean {
    return LEVEL_RANK[level] >= LEVEL_RANK[this.minLevel];
  }

  private format(level: LogLevel, msg: string): string {
    const style = LEVEL_STYLE[level];
    const ts = this.timestamps
      ? new Date().toISOString().replace("T", " ").slice(0, 19)
      : null;

    if (!this.tty) {
      // Plain text - no ANSI
      const parts: string[] = [];
      if (ts) parts.push(ts);
      if (this.namespace) parts.push(`[${this.namespace}]`);
      parts.push(`[${style.label}]`);
      parts.push(msg);
      return parts.join(" ");
    }

    const tsStr = ts ? `${DIM}${ts}${RESET} ` : "";
    const nsStr = this.namespace
      ? `${BOLD}[${this.namespace}]${RESET} `
      : "";
    const lvlStr = `${style.color}[${style.label}]${RESET}`;

    return `${tsStr}${nsStr}${lvlStr} ${msg}`;
  }

  private emit(level: LogLevel, msg: string): void {
    if (this.shouldEmit(level)) {
      this.output(this.format(level, msg));
    }
  }

  debug(msg: string): void   { this.emit("debug",   msg); }
  info(msg: string): void    { this.emit("info",    msg); }
  warn(msg: string): void    { this.emit("warn",    msg); }
  error(msg: string): void   { this.emit("error",   msg); }
  success(msg: string): void { this.emit("success", msg); }

  /** Return a child logger scoped to an additional namespace segment. */
  child(namespace: string): ColorLogger {
    const ns = this.namespace ? `${this.namespace}:${namespace}` : namespace;
    return new ColorLogger({
      minLevel: this.minLevel,
      namespace: ns,
      tty: this.tty,
      output: this.output,
      timestamps: this.timestamps,
    });
  }
}

/**
 * Factory function - primary public API.
 * @param namespace - optional namespace label shown in brackets
 * @param options   - additional options (minLevel, tty, output, timestamps)
 */
export function createLogger(
  namespace?: string,
  options: Omit<ColorLoggerOptions, "namespace"> = {}
): ColorLogger {
  return new ColorLogger({ ...options, namespace });
}
