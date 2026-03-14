/**
 * Run log — one line per agent run, appended to ~/.8gent/runs.jsonl
 *
 * No ceremony. Just the facts you'd scan in a terminal.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface RunLogEntry {
  /** ISO timestamp */
  ts: string;
  /** "ok" | "fail" | "timeout" */
  status: "ok" | "fail" | "timeout";
  /** Model identifier */
  model: string;
  /** Duration in seconds */
  dur: number;
  /** Total tokens consumed */
  tokens: number;
  /** Cost in USD (from OpenRouter), null if unknown */
  cost: number | null;
  /** Number of tool calls */
  tools: number;
  /** Files created */
  created: string[];
  /** Files modified */
  modified: string[];
  /** Session ID (for cross-ref with ~/.8gent/sessions/) */
  session: string;
  /** Working directory */
  cwd: string;
  /** First 120 chars of the prompt */
  prompt: string;
  /** Error message if failed */
  error?: string;
}

const LOG_PATH = path.join(os.homedir(), ".8gent", "runs.jsonl");

function ensureDir() {
  const dir = path.dirname(LOG_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function appendRun(entry: RunLogEntry): void {
  ensureDir();
  fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n");
}

export function readRuns(limit = 20): RunLogEntry[] {
  if (!fs.existsSync(LOG_PATH)) return [];

  const lines = fs.readFileSync(LOG_PATH, "utf-8").trim().split("\n").filter(Boolean);
  const entries: RunLogEntry[] = [];

  // Read from the end
  for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
    try {
      entries.push(JSON.parse(lines[i]));
    } catch {
      // skip malformed lines
    }
  }

  return entries;
}

export function getLogPath(): string {
  return LOG_PATH;
}
