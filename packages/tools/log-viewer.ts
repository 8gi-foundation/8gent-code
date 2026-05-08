/**
 * Eight Log Viewer - terminal debug log reader.
 *
 * Reads and formats Eight's log files (daemon.log, runs.jsonl, failures.jsonl,
 * session logs). Supports level filtering, text search, tail mode, and
 * colorized output.
 *
 * Usage:
 *   bun run packages/tools/log-viewer.ts                   # last 40 lines of daemon.log
 *   bun run packages/tools/log-viewer.ts --tail             # live tail
 *   bun run packages/tools/log-viewer.ts --level error      # errors only
 *   bun run packages/tools/log-viewer.ts --search "session"  # grep-like filter
 *   bun run packages/tools/log-viewer.ts --file runs         # view runs.jsonl
 *   bun run packages/tools/log-viewer.ts --lines 100         # last 100 lines
 */

import { existsSync, readFileSync, watchFile, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const DATA_DIR = join(homedir(), ".8gent");

const LOG_FILES: Record<string, string> = {
  daemon: join(DATA_DIR, "daemon.log"),
  runs: join(DATA_DIR, "runs.jsonl"),
  failures: join(DATA_DIR, "healing", "failures.jsonl"),
};

// ANSI color helpers - no deps
const c = {
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

type Level = "error" | "warn" | "info" | "debug" | "all";

const LEVEL_PATTERNS: Record<Exclude<Level, "all">, RegExp> = {
  error: /\[agent:error\]|\[error\]|fatal|panic|exception/i,
  warn: /\[warn\]|warning|timeout|retry/i,
  info: /\[session:|tool:result|memory:saved|\[daemon\]/i,
  debug: /\[tool:start\]|\[agent:thinking\]|\[agent:stream\]/i,
};

function classifyLine(line: string): Exclude<Level, "all"> {
  if (LEVEL_PATTERNS.error.test(line)) return "error";
  if (LEVEL_PATTERNS.warn.test(line)) return "warn";
  if (LEVEL_PATTERNS.debug.test(line)) return "debug";
  return "info";
}

function colorize(line: string): string {
  const level = classifyLine(line);
  // Highlight the ISO timestamp portion
  const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\s/);
  let out = line;
  if (tsMatch) {
    out = c.dim(tsMatch[1]) + line.slice(tsMatch[1].length);
  }
  switch (level) {
    case "error": return c.red(out);
    case "warn": return c.yellow(out);
    case "debug": return c.dim(out);
    default: return out;
  }
}

function shouldShow(line: string, level: Level, search: string | null): boolean {
  if (!line.trim()) return false;
  if (search && !line.toLowerCase().includes(search.toLowerCase())) return false;
  if (level === "all") return true;
  const lineLevel = classifyLine(line);
  const priority: Record<Exclude<Level, "all">, number> = { error: 3, warn: 2, info: 1, debug: 0 };
  return priority[lineLevel] >= priority[level];
}

function readTail(filePath: string, n: number): string[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter(Boolean);
  return lines.slice(-n);
}

function tailMode(filePath: string, level: Level, search: string | null): void {
  if (!existsSync(filePath)) {
    console.error(c.red(`File not found: ${filePath}`));
    process.exit(1);
  }
  let lastSize = statSync(filePath).size;
  console.log(c.cyan(`-- tailing ${filePath} (Ctrl+C to stop) --`));

  watchFile(filePath, { interval: 500 }, () => {
    const currentSize = statSync(filePath).size;
    if (currentSize <= lastSize) { lastSize = currentSize; return; }
    const fd = require("fs").openSync(filePath, "r");
    const buf = Buffer.alloc(currentSize - lastSize);
    require("fs").readSync(fd, buf, 0, buf.length, lastSize);
    require("fs").closeSync(fd);
    lastSize = currentSize;
    const newLines = buf.toString("utf-8").split("\n").filter(Boolean);
    for (const line of newLines) {
      if (shouldShow(line, level, search)) {
        console.log(colorize(line));
      }
    }
  });
}

// --- CLI ---
function parseArgs(argv: string[]) {
  const args = { file: "daemon", level: "all" as Level, search: null as string | null, tail: false, lines: 40 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tail" || a === "-f") args.tail = true;
    else if ((a === "--level" || a === "-l") && argv[i + 1]) args.level = argv[++i] as Level;
    else if ((a === "--search" || a === "-s") && argv[i + 1]) args.search = argv[++i];
    else if ((a === "--file") && argv[i + 1]) args.file = argv[++i];
    else if ((a === "--lines" || a === "-n") && argv[i + 1]) args.lines = parseInt(argv[++i], 10);
    else if (a === "--help" || a === "-h") {
      console.log("Usage: log-viewer [--file daemon|runs|failures] [--level error|warn|info|debug|all]");
      console.log("       [--search <text>] [--tail] [--lines <n>]");
      process.exit(0);
    }
  }
  return args;
}

const args = parseArgs(process.argv);
const filePath = LOG_FILES[args.file] || args.file;

if (args.tail) {
  tailMode(filePath, args.level, args.search);
} else {
  const lines = readTail(filePath, args.lines);
  const filtered = lines.filter((l) => shouldShow(l, args.level, args.search));
  if (filtered.length === 0) {
    console.log(c.dim(`No matching lines in ${filePath}`));
  } else {
    console.log(c.cyan(`-- ${filePath} (${filtered.length} lines) --`));
    for (const line of filtered) console.log(colorize(line));
  }
}
