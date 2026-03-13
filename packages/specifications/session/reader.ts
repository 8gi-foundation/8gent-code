/**
 * 8gent Session Reader
 *
 * Reads session JSONL files for the debugger and reporting tools.
 * Supports both full reads and streaming (for live tailing).
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as readline from "readline";
import type {
  SessionEntry,
  SessionStartEntry,
  SessionEndEntry,
  SessionMeta,
} from "./index.js";

const SESSIONS_DIR = path.join(os.homedir(), ".8gent", "sessions");

// ============================================
// Session list item (for sidebar/index)
// ============================================

export interface SessionListItem {
  sessionId: string;
  filePath: string;
  startedAt: string;
  modifiedAt: string;
  sizeBytes: number;
  lineCount: number;
  /** First user message (preview) */
  firstUserMessage: string | null;
  /** Model used */
  model: string | null;
  /** Runtime backend */
  runtime: string | null;
  /** Git branch */
  gitBranch: string | null;
  /** Working directory / project path */
  workingDirectory: string | null;
  /** Whether session_end was written (clean exit) */
  completed: boolean;
  /** Exit reason if completed */
  exitReason: string | null;
  /** Session duration if completed */
  durationMs: number | null;
}

// ============================================
// List all sessions
// ============================================

export async function listSessions(
  sessionsDir?: string
): Promise<SessionListItem[]> {
  const dir = sessionsDir || SESSIONS_DIR;

  if (!fs.existsSync(dir)) {
    return [];
  }

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  const sessions: SessionListItem[] = [];

  for (const file of files) {
    const filePath = path.join(dir, file);
    const fileStat = fs.statSync(filePath);
    const sessionId = file.replace(".jsonl", "");

    const meta = await extractSessionMeta(filePath);

    sessions.push({
      sessionId,
      filePath,
      startedAt: meta.startedAt || fileStat.birthtime.toISOString(),
      modifiedAt: fileStat.mtime.toISOString(),
      sizeBytes: fileStat.size,
      lineCount: meta.lineCount,
      firstUserMessage: meta.firstUserMessage,
      model: meta.model,
      runtime: meta.runtime,
      gitBranch: meta.gitBranch,
      workingDirectory: meta.workingDirectory,
      completed: meta.completed,
      exitReason: meta.exitReason,
      durationMs: meta.durationMs,
    });
  }

  // Newest first
  sessions.sort(
    (a, b) =>
      new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime()
  );

  return sessions;
}

// ============================================
// Extract metadata by scanning file
// ============================================

interface ExtractedMeta {
  startedAt: string | null;
  firstUserMessage: string | null;
  model: string | null;
  runtime: string | null;
  gitBranch: string | null;
  workingDirectory: string | null;
  completed: boolean;
  exitReason: string | null;
  durationMs: number | null;
  lineCount: number;
}

async function extractSessionMeta(filePath: string): Promise<ExtractedMeta> {
  return new Promise((resolve) => {
    const result: ExtractedMeta = {
      startedAt: null,
      firstUserMessage: null,
      model: null,
      runtime: null,
      gitBranch: null,
      workingDirectory: null,
      completed: false,
      exitReason: null,
      durationMs: null,
      lineCount: 0,
    };

    let lastLine: string | null = null;

    const rl = readline.createInterface({
      input: fs.createReadStream(filePath),
      crlfDelay: Infinity,
    });

    rl.on("line", (line) => {
      result.lineCount++;
      lastLine = line;

      // Only parse first few lines + last line for speed
      if (result.lineCount <= 10 || !result.firstUserMessage) {
        try {
          const entry = JSON.parse(line) as SessionEntry;

          if (entry.type === "session_start") {
            const start = entry as SessionStartEntry;
            result.startedAt = start.meta.startedAt;
            result.model = start.meta.agent.model;
            result.runtime = start.meta.agent.runtime;
            result.gitBranch = start.meta.environment.gitBranch ?? null;
            result.workingDirectory =
              start.meta.environment.workingDirectory ?? null;
          }

          if (entry.type === "user_message" && !result.firstUserMessage) {
            result.firstUserMessage = entry.message.content.slice(0, 120);
          }
        } catch {
          // skip
        }
      }
    });

    rl.on("close", () => {
      // Check if last line is session_end
      if (lastLine) {
        try {
          const entry = JSON.parse(lastLine) as SessionEntry;
          if (entry.type === "session_end") {
            const end = entry as SessionEndEntry;
            result.completed = true;
            result.exitReason = end.summary.exitReason;
            result.durationMs = end.summary.durationMs;
          }
        } catch {
          // skip
        }
      }
      resolve(result);
    });

    rl.on("error", () => resolve(result));
  });
}

// ============================================
// Full session reader
// ============================================

export class SessionReader {
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** Read all entries from the session file */
  async readAll(): Promise<SessionEntry[]> {
    const entries: SessionEntry[] = [];

    const rl = readline.createInterface({
      input: fs.createReadStream(this.filePath),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as SessionEntry);
      } catch {
        // skip malformed lines
      }
    }

    return entries;
  }

  /** Stream entries as they're appended (for live tailing) */
  async *stream(
    startAfterSeq?: number
  ): AsyncGenerator<SessionEntry, void, unknown> {
    const rl = readline.createInterface({
      input: fs.createReadStream(this.filePath),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as SessionEntry;
        if (
          startAfterSeq !== undefined &&
          entry.sequenceNumber <= startAfterSeq
        ) {
          continue;
        }
        yield entry;
      } catch {
        // skip
      }
    }
  }

  /** Get the session metadata (first entry) */
  async getMeta(): Promise<SessionMeta | null> {
    const rl = readline.createInterface({
      input: fs.createReadStream(this.filePath),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as SessionEntry;
        if (entry.type === "session_start") {
          rl.close();
          return (entry as SessionStartEntry).meta;
        }
      } catch {
        // skip
      }
      break; // Only check first line
    }

    return null;
  }
}
