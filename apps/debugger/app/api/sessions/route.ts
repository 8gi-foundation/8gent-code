import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const SESSIONS_DIR = join(homedir(), ".8gent", "sessions");
const JSONL_SUFFIX = ".jsonl";

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
	/** Schema version (1 or 2) */
	version: number;
	/** v2: Total steps completed */
	totalSteps: number | null;
}

interface SessionMeta {
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
	version: number;
	totalSteps: number | null;
}

async function getSessionMeta(filePath: string): Promise<SessionMeta> {
	return new Promise((resolve) => {
		const result: SessionMeta = {
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
			version: 1,
			totalSteps: null,
		};

		let lastLine: string | null = null;

		const rl = createInterface({
			input: createReadStream(filePath),
			crlfDelay: Number.POSITIVE_INFINITY,
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
						result.workingDirectory = entry.meta.environment?.workingDirectory ?? null;
						result.version = entry.meta.version ?? 1;
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
						result.totalSteps = entry.summary.totalSteps ?? entry.summary.totalTurns ?? null;
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

async function buildSessionInfo(file: string): Promise<SessionInfo> {
	const filePath = join(SESSIONS_DIR, file);
	const fileStat = await stat(filePath);
	const sessionId = file.replace(JSONL_SUFFIX, "");
	const meta = await getSessionMeta(filePath);

	return {
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
		version: meta.version,
		totalSteps: meta.totalSteps,
	};
}

export async function GET() {
	console.log(`[Sessions API] Listing sessions from ${SESSIONS_DIR}`);
	try {
		let entries: string[] = [];
		try {
			// Live directory: contents change between requests as new sessions land. Cannot hoist.
			// react-doctor-disable-next-line react-doctor/server-hoist-static-io
			entries = await readdir(SESSIONS_DIR);
		} catch (dirErr) {
			console.log(`[Sessions API] Directory not found: ${SESSIONS_DIR}`, dirErr);
			return NextResponse.json([]);
		}

		const files = entries.filter((f) => f.endsWith(JSONL_SUFFIX));
		console.log(`[Sessions API] Found ${files.length} .jsonl files:`, files);

		// Parallel read so the route is bounded by the slowest file, not the sum.
		const sessions = await Promise.all(files.map(buildSessionInfo));

		// Newest first
		sessions.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());

		return NextResponse.json(sessions);
	} catch (error) {
		return NextResponse.json(
			{ error: "Failed to read sessions", detail: String(error) },
			{ status: 500 },
		);
	}
}
