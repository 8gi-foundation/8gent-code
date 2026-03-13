import { NextResponse } from "next/server";
import { readdir, stat } from "fs/promises";
import { join } from "path";
import { createReadStream } from "fs";
import { createInterface } from "readline";

export const dynamic = "force-dynamic";
import { homedir } from "os";

export interface SessionInfo {
  sessionId: string;
  filePath: string;
  startedAt: string;
  modifiedAt: string;
  sizeBytes: number;
  lineCount: number;
  firstUserMessage: string | null;
  model: string | null;
  runtime: string | null;
  gitBranch: string | null;
  workingDirectory: string | null;
  completed: boolean;
  exitReason: string | null;
  durationMs: number | null;
}

const SESSIONS_DIR = join(homedir(), ".8gent", "sessions");

async function getSessionMeta(filePath: string): Promise<{
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
}> {
  return new Promise((resolve) => {
    const result = {
      startedAt: null as string | null,
      firstUserMessage: null as string | null,
      model: null as string | null,
      runtime: null as string | null,
      gitBranch: null as string | null,
      workingDirectory: null as string | null,
      completed: false,
      exitReason: null as string | null,
      durationMs: null as number | null,
      lineCount: 0,
    };

    let lastLine: string | null = null;

    const rl = createInterface({
      input: createReadStream(filePath),
      crlfDelay: Infinity,
    });

    rl.on("line", (line) => {
      result.lineCount++;
      lastLine = line;

      if (result.lineCount <= 10 || !result.firstUserMessage) {
        try {
          const entry = JSON.parse(line);

          if (entry.type === "session_start" && entry.meta) {
            result.startedAt = entry.meta.startedAt;
            result.model = entry.meta.agent?.model ?? null;
            result.runtime = entry.meta.agent?.runtime ?? null;
            result.gitBranch = entry.meta.environment?.gitBranch ?? null;
            result.workingDirectory =
              entry.meta.environment?.workingDirectory ?? null;
          }

          if (entry.type === "user_message" && !result.firstUserMessage) {
            result.firstUserMessage = entry.message?.content?.slice(0, 120) ?? null;
          }
        } catch {
          // skip malformed
        }
      }
    });

    rl.on("close", () => {
      // Check if last line is session_end
      if (lastLine) {
        try {
          const entry = JSON.parse(lastLine);
          if (entry.type === "session_end" && entry.summary) {
            result.completed = true;
            result.exitReason = entry.summary.exitReason ?? null;
            result.durationMs = entry.summary.durationMs ?? null;
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

export async function GET() {
  console.log(`[Sessions API] Listing sessions from ${SESSIONS_DIR}`);
  try {
    let files: string[] = [];
    try {
      files = (await readdir(SESSIONS_DIR)).filter((f) =>
        f.endsWith(".jsonl")
      );
      console.log(`[Sessions API] Found ${files.length} .jsonl files:`, files);
    } catch (dirErr) {
      console.log(`[Sessions API] Directory not found: ${SESSIONS_DIR}`, dirErr);
      return NextResponse.json([]);
    }

    const sessions: SessionInfo[] = [];

    for (const file of files) {
      const filePath = join(SESSIONS_DIR, file);
      const fileStat = await stat(filePath);
      const sessionId = file.replace(".jsonl", "");
      const meta = await getSessionMeta(filePath);

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

    return NextResponse.json(sessions);
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to read sessions", detail: String(error) },
      { status: 500 }
    );
  }
}
