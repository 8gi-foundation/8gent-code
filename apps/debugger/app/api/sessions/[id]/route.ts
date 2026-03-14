import { NextRequest, NextResponse } from "next/server";
import { readFile, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

export const dynamic = "force-dynamic";

const SESSIONS_DIR = join(homedir(), ".8gent", "sessions");

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sessionId } = await params;
  const filePath = join(SESSIONS_DIR, `${sessionId}.jsonl`);

  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat?.isFile()) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const content = await readFile(filePath, "utf-8");
  const entries = content
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  return NextResponse.json(entries);
}
