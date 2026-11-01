/**
 * 8gent Code - Time-Travel Checkpoint Store
 *
 * Content-addressed checkpoint store for session time-travel. Issue #2757,
 * step 1. Every checkpoint records the full message history of a session,
 * but each message blob is stored exactly once (keyed by sha256 of its
 * serialised form), so consecutive checkpoints that share a prefix cost
 * only the new messages plus one small metadata line.
 *
 * Layout under the data dir (default ~/.8gent/timetravel):
 *
 *   blobs/<hh>/<sha256>.json            message blobs, shared across sessions
 *   sessions/<sessionId>/checkpoints.jsonl   append-only checkpoint log
 *
 * Local-first by design: everything stays on disk, nothing leaves the
 * machine. The store is synchronous and dependency-free so it can sit on
 * the agent hot path without pulling anything into cold start.
 *
 * Verbs shipped in this slice: save, list, latest, load, rewind, fork.
 * TUI/daemon wiring of rewind/fork (issue step 2) builds on these.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---- Public types --------------------------------------------------------

export interface CheckpointMessage {
	role: string;
	content: string;
}

export type CheckpointReason = "interval" | "phase" | "manual" | "fork";

export interface CheckpointMeta {
	/** Unique checkpoint id, `cp_` prefixed. */
	id: string;
	/** Session this checkpoint belongs to. */
	sessionId: string;
	/** Previous checkpoint in the same session, null for the first. */
	parentId: string | null;
	/** When reason is "fork": the source checkpoint id in the source session. */
	forkedFrom: string | null;
	reason: CheckpointReason;
	/** Cumulative tool calls in the session at checkpoint time. */
	toolCallCount: number;
	messageCount: number;
	/** Ordered content hashes; the checkpoint is reconstructed from these. */
	messageHashes: string[];
	/** Blobs newly written by this save. 0 means the state was fully deduped. */
	newBlobs: number;
	label?: string;
	createdAt: number;
}

export interface SaveOptions {
	reason: CheckpointReason;
	toolCallCount?: number;
	label?: string;
}

export interface RestoredCheckpoint {
	meta: CheckpointMeta;
	messages: CheckpointMessage[];
}

// ---- Helpers -------------------------------------------------------------

function defaultDataDir(): string {
	// EIGHT_TIMETRAVEL_DIR relocates the store (tests, ops, shared volumes).
	const override = process.env.EIGHT_TIMETRAVEL_DIR;
	if (override && override.trim() !== "") return override;
	return path.join(os.homedir(), ".8gent", "timetravel");
}

function sha256Hex(input: string): string {
	return createHash("sha256").update(input, "utf8").digest("hex");
}

let counter = 0;
function makeCheckpointId(): string {
	return `cp_${Date.now().toString(36)}_${(counter++).toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Session ids become directory names. Reject anything that could escape
 * the store root; the agent's own `session_<ts>_<rand>` ids always pass.
 */
function assertSafeSessionId(sessionId: string): void {
	if (!/^[A-Za-z0-9._-]+$/.test(sessionId) || sessionId === "." || sessionId === "..") {
		throw new Error(`TimeTravelStore: unsafe session id "${sessionId}"`);
	}
}

// ---- Store ---------------------------------------------------------------

export class TimeTravelStore {
	private readonly dataDir: string;

	constructor(options?: { dataDir?: string }) {
		this.dataDir = options?.dataDir ?? defaultDataDir();
	}

	/**
	 * Snapshot the full message history as a checkpoint. Blobs already in
	 * the store are not rewritten, so back-to-back saves are near-free.
	 */
	save(sessionId: string, messages: CheckpointMessage[], options: SaveOptions): CheckpointMeta {
		assertSafeSessionId(sessionId);

		let newBlobs = 0;
		const messageHashes: string[] = [];
		for (const message of messages) {
			const serialised = JSON.stringify({ role: message.role, content: message.content });
			const hash = sha256Hex(serialised);
			messageHashes.push(hash);
			if (this.writeBlobIfAbsent(hash, serialised)) newBlobs++;
		}

		const meta: CheckpointMeta = {
			id: makeCheckpointId(),
			sessionId,
			parentId: this.latest(sessionId)?.id ?? null,
			forkedFrom: null,
			reason: options.reason,
			toolCallCount: options.toolCallCount ?? 0,
			messageCount: messages.length,
			messageHashes,
			newBlobs,
			label: options.label,
			createdAt: Date.now(),
		};
		this.appendMeta(meta);
		return meta;
	}

	/** All checkpoints for a session, oldest first. */
	list(sessionId: string): CheckpointMeta[] {
		assertSafeSessionId(sessionId);
		const logPath = this.checkpointLogPath(sessionId);
		let raw: string;
		try {
			raw = fs.readFileSync(logPath, "utf8");
		} catch {
			return [];
		}
		const metas: CheckpointMeta[] = [];
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				metas.push(JSON.parse(trimmed) as CheckpointMeta);
			} catch {
				// A torn write (crash mid-append) loses one line, never the log.
			}
		}
		return metas;
	}

	/** Most recent checkpoint for a session, or null. */
	latest(sessionId: string): CheckpointMeta | null {
		const metas = this.list(sessionId);
		return metas.length > 0 ? metas[metas.length - 1] : null;
	}

	/** Reconstruct the message history of a checkpoint from its blobs. */
	load(sessionId: string, checkpointId: string): RestoredCheckpoint {
		const meta = this.list(sessionId).find((m) => m.id === checkpointId);
		if (!meta) {
			throw new Error(`TimeTravelStore: checkpoint ${checkpointId} not found in ${sessionId}`);
		}
		return { meta, messages: this.readMessages(meta) };
	}

	/**
	 * Go back n checkpoints from the latest. rewind(0) is the latest
	 * checkpoint, rewind(1) the one before it. Returns null when the
	 * session has no checkpoint that far back.
	 */
	rewind(sessionId: string, n: number): RestoredCheckpoint | null {
		if (!Number.isInteger(n) || n < 0) {
			throw new Error(`TimeTravelStore: rewind steps must be a non-negative integer, got ${n}`);
		}
		const metas = this.list(sessionId);
		const index = metas.length - 1 - n;
		if (index < 0) return null;
		const meta = metas[index];
		return { meta, messages: this.readMessages(meta) };
	}

	/**
	 * Start a new session lineage from an existing checkpoint. Blobs are
	 * shared, so a fork writes one metadata line and zero blobs. The two
	 * lineages then diverge independently: explore two fixes from the
	 * same state.
	 */
	fork(sessionId: string, checkpointId: string, newSessionId: string): CheckpointMeta {
		assertSafeSessionId(newSessionId);
		const source = this.list(sessionId).find((m) => m.id === checkpointId);
		if (!source) {
			throw new Error(`TimeTravelStore: checkpoint ${checkpointId} not found in ${sessionId}`);
		}
		const meta: CheckpointMeta = {
			id: makeCheckpointId(),
			sessionId: newSessionId,
			parentId: this.latest(newSessionId)?.id ?? null,
			forkedFrom: source.id,
			reason: "fork",
			toolCallCount: source.toolCallCount,
			messageCount: source.messageCount,
			messageHashes: [...source.messageHashes],
			newBlobs: 0,
			label: source.label,
			createdAt: Date.now(),
		};
		this.appendMeta(meta);
		return meta;
	}

	// ---- Internals -------------------------------------------------------

	private blobPath(hash: string): string {
		return path.join(this.dataDir, "blobs", hash.slice(0, 2), `${hash}.json`);
	}

	private checkpointLogPath(sessionId: string): string {
		return path.join(this.dataDir, "sessions", sessionId, "checkpoints.jsonl");
	}

	/** Returns true when the blob was newly written. */
	private writeBlobIfAbsent(hash: string, serialised: string): boolean {
		const blobPath = this.blobPath(hash);
		if (fs.existsSync(blobPath)) return false;
		fs.mkdirSync(path.dirname(blobPath), { recursive: true });
		// Write-then-rename so a crash never leaves a torn blob at the
		// content address.
		const tmpPath = `${blobPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
		fs.writeFileSync(tmpPath, serialised, "utf8");
		fs.renameSync(tmpPath, blobPath);
		return true;
	}

	private appendMeta(meta: CheckpointMeta): void {
		const logPath = this.checkpointLogPath(meta.sessionId);
		fs.mkdirSync(path.dirname(logPath), { recursive: true });
		fs.appendFileSync(logPath, `${JSON.stringify(meta)}\n`, "utf8");
	}

	private readMessages(meta: CheckpointMeta): CheckpointMessage[] {
		return meta.messageHashes.map((hash) => {
			const raw = fs.readFileSync(this.blobPath(hash), "utf8");
			return JSON.parse(raw) as CheckpointMessage;
		});
	}
}

// ---- Interval policy -----------------------------------------------------

export const DEFAULT_CHECKPOINT_EVERY = 8;

/**
 * How many tool calls between automatic checkpoints. Controlled by
 * EIGHT_CHECKPOINT_EVERY; 0 disables interval checkpoints entirely.
 */
export function checkpointEveryFromEnv(
	env: Record<string, string | undefined> = process.env,
): number {
	const raw = env.EIGHT_CHECKPOINT_EVERY;
	if (raw === undefined || raw === "") return DEFAULT_CHECKPOINT_EVERY;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n < 0) return DEFAULT_CHECKPOINT_EVERY;
	return n;
}
