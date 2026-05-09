import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const SESSIONS_DIR = join(homedir(), ".8gent", "sessions");
const JSONL_SUFFIX = ".jsonl";

function parseJsonlLine(line: string): unknown | null {
	try {
		return JSON.parse(line);
	} catch {
		return null;
	}
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
	const { id: sessionId } = await params;
	const filePath = join(SESSIONS_DIR, `${sessionId}${JSONL_SUFFIX}`);

	// Per-request session file derived from sessionId param; not a static asset, cannot hoist.
	// react-doctor-disable-next-line react-doctor/server-hoist-static-io
	const fileStat = await stat(filePath).catch(() => null);
	if (!fileStat?.isFile()) {
		return NextResponse.json({ error: "Session not found" }, { status: 404 });
	}

	// Per-request session file (live JSONL log); contents change every read.
	// react-doctor-disable-next-line react-doctor/server-hoist-static-io
	const content = await readFile(filePath, "utf-8");
	// Combined parse + filter walks the array once instead of split→filter→map→filter.
	const entries: unknown[] = [];
	for (const line of content.split("\n")) {
		if (!line) continue;
		const parsed = parseJsonlLine(line);
		if (parsed !== null) entries.push(parsed);
	}

	return NextResponse.json(entries);
}
