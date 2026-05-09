/**
 * 8gent Code - TurnJournal
 *
 * Per-turn replayable JSON record for debugging and governance audit.
 * One file per turn at: ~/.8gent/turns/{sessionId}/{turnIndex}.json
 *
 * Pure append, never edited. The system prompt is hashed (not stored)
 * to avoid duplicating large prompts on disk per turn. Tool result
 * previews are capped at 1KB; oversized results are referenced via the
 * shared ArtifactStore chip format `[ARTIFACT <hash> <size>]` (#2463).
 *
 * Issue #2470. Concept extracted from StartupHakk/OpenMonoAgent under
 * CleanRoomPort rules; no AGPL source copied.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---- Public types --------------------------------------------------------

export interface ToolCallRecord {
	id: string;
	name: string;
	args: unknown;
	resultPreview: string;
	durationMs: number;
	cached: boolean;
	redacted: boolean;
}

export interface TurnRecord {
	sessionId: string;
	turnIndex: number;
	startedAt: string;
	finishedAt: string;
	input: { role: "user"; content: string };
	systemPromptHash: string;
	systemPromptLength: number;
	toolCalls: ToolCallRecord[];
	modelOutput: {
		content: string;
		tokens: { in: number; out: number; total: number };
	};
	latencyMs: number;
	status: "ok" | "errored";
	error?: string;
}

// ---- Constants -----------------------------------------------------------

const PREVIEW_BYTES = 1024;
const HASH_PREFIX_LEN = 8;

// ---- Helpers -------------------------------------------------------------

function defaultDataDir(): string {
	return path.join(os.homedir(), ".8gent", "turns");
}

function formatSize(bytes: number): string {
	if (bytes >= 1024 * 1024) {
		const mb = bytes / (1024 * 1024);
		return mb % 1 === 0 ? `${mb}MB` : `${mb.toFixed(1)}MB`;
	}
	const kb = bytes / 1024;
	return kb % 1 === 0 ? `${kb}KB` : `${kb.toFixed(1)}KB`;
}

function sha256Hex(input: string): string {
	return createHash("sha256").update(input, "utf8").digest("hex");
}

// ---- Public API ----------------------------------------------------------

export class TurnJournal {
	readonly sessionId: string;
	private readonly root: string;

	constructor(sessionId: string, dataDir?: string) {
		this.sessionId = sessionId;
		this.root = dataDir ?? defaultDataDir();
	}

	/**
	 * Hash a system prompt down to {hash, length}. Used at session boot so
	 * the agent can stamp every TurnRecord without re-hashing each turn.
	 */
	static hashSystemPrompt(text: string): { hash: string; length: number } {
		return { hash: sha256Hex(text), length: text.length };
	}

	/**
	 * Cap a tool result preview at 1KB. When over, return a chip in the
	 * exact format ArtifactStore (#2463) emits so downstream readers can
	 * resolve the reference uniformly.
	 */
	static clampToolPreview(result: string): string {
		if (typeof result !== "string") return result;
		const byteLen = Buffer.byteLength(result, "utf8");
		if (byteLen <= PREVIEW_BYTES) return result;
		const hash = sha256Hex(result).slice(0, HASH_PREFIX_LEN);
		return `[ARTIFACT ${hash} ${formatSize(byteLen)}]`;
	}

	/**
	 * Persist a TurnRecord. Atomic via write-to-tmp + rename so a partial
	 * file is never observable. Idempotent re-writes overwrite cleanly.
	 */
	async write(record: TurnRecord): Promise<void> {
		const sessionDir = path.join(this.root, record.sessionId);
		await fs.promises.mkdir(sessionDir, { recursive: true });
		const finalPath = path.join(sessionDir, `${record.turnIndex}.json`);
		const tmpPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
		const payload = JSON.stringify(record, null, 2);
		await fs.promises.writeFile(tmpPath, payload, "utf8");
		await fs.promises.rename(tmpPath, finalPath);
	}

	/** Read a single TurnRecord. Returns null when the turn does not exist. */
	async read(sessionId: string, turnIndex: number): Promise<TurnRecord | null> {
		const filePath = path.join(this.root, sessionId, `${turnIndex}.json`);
		try {
			const raw = await fs.promises.readFile(filePath, "utf8");
			return JSON.parse(raw) as TurnRecord;
		} catch (err: unknown) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return null;
			throw err;
		}
	}

	/** List turn indices for a session in ascending order. */
	async list(sessionId: string): Promise<number[]> {
		const sessionDir = path.join(this.root, sessionId);
		let entries: string[];
		try {
			entries = await fs.promises.readdir(sessionDir);
		} catch (err: unknown) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return [];
			throw err;
		}
		const indices: number[] = [];
		for (const entry of entries) {
			const m = entry.match(/^(\d+)\.json$/);
			if (m) indices.push(Number.parseInt(m[1], 10));
		}
		return indices.sort((a, b) => a - b);
	}
}
