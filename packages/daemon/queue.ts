/**
 * Durable work queue in front of the session pool (#4254, EIGHT_WORK_QUEUE=1, off by default).
 *
 * Concepts from Cloudroom (David Ondrej) and Daedalus (0xyg3n): accept work under
 * a caller-supplied requestId, keep it on disk, run it once. Rebuilt here; no code taken.
 *
 * The store is append-only JSONL, one event per line: accept, start, end, unknown.
 * - Enqueue is idempotent: a known requestId returns its original receipt and never runs twice.
 * - Items start in acceptance order.
 * - After a restart, accepted items that never started run once; an item that had
 *   started but not ended is marked unknown and is never resent.
 * - One writer per file: `<path>.lock` holds the owner pid and is created atomically.
 *   A lock whose pid is no longer alive is stale and taken over (see acquireLock).
 *   The pool releases it on a clean stop (AgentPool.shutdown, from the daemon's
 *   SIGTERM/SIGINT handler).
 *
 * Growth: the file is never compacted, so it grows by one line per event for the
 * life of the data dir, and replay reads all of it at startup. Compaction must keep
 * every finished requestId (or idempotency breaks: a resend would run again), so
 * it is its own change: https://github.com/8gi-foundation/8gent-code/issues/4256
 */

import { randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	fchmodSync,
	fsyncSync,
	linkSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { cpus } from "node:os";
import { dirname } from "node:path";

export type QueueStatus = "queued" | "running" | "done" | "failed" | "unknown";

export interface QueueRequest {
	requestId: string;
	text: string;
	/** Run on this session (waiting until it is idle). Omitted: a one-shot session for this item. */
	sessionId?: string;
	channel?: string;
}

export interface Receipt {
	requestId: string;
	seq: number;
	acceptedAt: number;
}

export interface QueueItem {
	receipt: Receipt;
	text: string;
	channel: string;
	sessionId?: string;
	status: QueueStatus;
}

type Line =
	| ({ op: "accept"; text: string; channel: string; sessionId?: string } & Receipt)
	| { op: "start" | "unknown"; requestId: string }
	| { op: "end"; requestId: string; ok: boolean };

/** Concurrent starts: EIGHT_WORK_QUEUE_STARTS, else half the logical CPUs; at least 1, at most maxSessions. */
export function startLimitFor(maxSessions: number, requested?: number): number {
	const env = Number(process.env.EIGHT_WORK_QUEUE_STARTS);
	const n = requested ?? (Number.isInteger(env) && env > 0 ? env : Math.floor(cpus().length / 2));
	return Math.min(Math.max(1, n), maxSessions);
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

const errCode = (err: unknown) => (err as NodeJS.ErrnoException).code;
const uniqueSuffix = (owner: number) => `${owner}.${randomBytes(6).toString("hex")}`;

/**
 * Create `lockPath` holding `owner`, or return false when it exists. The pid is
 * written to a private temp file first and hard-linked into place, so the lock is
 * never visible empty (an empty lock would read as stale and be taken over).
 */
function createLock(lockPath: string, owner: number): boolean {
	const tmp = `${lockPath}.${uniqueSuffix(owner)}.tmp`;
	const fd = openSync(tmp, "wx", 0o600);
	try {
		writeSync(fd, `${owner}\n`);
		closeSync(fd);
		linkSync(tmp, lockPath);
		return true;
	} catch (err) {
		if (errCode(err) === "EEXIST") return false;
		throw err;
	} finally {
		try {
			unlinkSync(tmp);
		} catch {}
	}
}

export interface LockOptions {
	/** Pid written into the lock. Default: this process. */
	owner?: number;
	/** Liveness check for the pid found in an existing lock. */
	alive?: (pid: number) => boolean;
	/** Test seam: runs after a stale owner is read and before the takeover rename. */
	beforeTakeover?: () => void;
}

/**
 * Take `lockPath` for one writer. Throws when a live process holds it.
 *
 * Stale takeover is a rename, not an unlink: a taker moves the lock to a name only
 * it knows, then checks that what it moved still holds the dead pid it judged.
 * - Two takers on one stale lock: only one rename finds the file; the other gets
 *   ENOENT, loops, and loses the create to the winner's lock.
 * - A taker that read the dead pid but renames after a rival already replaced the
 *   lock finds a live pid in what it moved: it links the rival's lock back and
 *   reports it held. It never deletes a lock it did not judge stale.
 *
 * Limits: if a third daemon starts in the instant between that rename and the link
 * back, the rival's lock cannot be restored (we report held, but two writers are
 * possible); that needs three daemons starting on one data dir within microseconds.
 * Pid reuse: liveness is `kill(pid, 0)` only, with no process start-time check
 * (darwin would need a `ps` spawn). A dead owner's pid reused by an unrelated live
 * process reads as held, so the queue stays off: it fails safe, never two writers,
 * and the error names the lock file to delete.
 */
export function acquireLock(lockPath: string, opts: LockOptions = {}): void {
	const owner = opts.owner ?? process.pid;
	const alive = opts.alive ?? pidAlive;
	for (let attempt = 0; attempt < 3; attempt++) {
		if (createLock(lockPath, owner)) return;
		let judged: string;
		try {
			judged = readFileSync(lockPath, "utf8");
		} catch (err) {
			if (errCode(err) === "ENOENT") continue; // released between our create and read
			throw err;
		}
		const holder = Number.parseInt(judged, 10);
		if (Number.isInteger(holder) && holder > 0 && alive(holder)) {
			throw new Error(
				`work queue: ${lockPath} is locked by pid ${holder}; another daemon owns this queue`,
			);
		}
		opts.beforeTakeover?.();
		const moved = `${lockPath}.stale.${uniqueSuffix(owner)}`;
		try {
			renameSync(lockPath, moved);
		} catch (err) {
			if (errCode(err) === "ENOENT") continue; // another taker moved it first
			throw err;
		}
		const took = readFileSync(moved, "utf8");
		if (took === judged) {
			unlinkSync(moved); // exactly the stale lock we judged: gone
			continue;
		}
		// We moved a lock a rival took after our read: put it back, untouched.
		try {
			linkSync(moved, lockPath);
		} catch {}
		unlinkSync(moved);
		throw new Error(
			`work queue: ${lockPath} is locked by pid ${Number.parseInt(took, 10)}; another daemon owns this queue`,
		);
	}
	throw new Error(`work queue: could not take ${lockPath}`);
}

export class WorkQueue {
	private items = new Map<string, QueueItem>();
	/** requestIds waiting to start, oldest first. */
	private pending: string[] = [];
	private fd: number;
	private nextSeq = 1;
	private running = 0;
	private readonly lockPath: string;
	private closed = false;
	readonly startLimit: number;
	/** Items that were in flight when the previous process stopped. Reported, never resent. */
	readonly unknownAfterRestart: string[] = [];

	constructor(
		readonly path: string,
		opts: { maxSessions: number; startLimit?: number },
	) {
		this.startLimit = startLimitFor(opts.maxSessions, opts.startLimit);
		// A missing directory is born private; an existing one is the user's and keeps its mode.
		const dir = dirname(path);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
		this.lockPath = `${path}.lock`;
		acquireLock(this.lockPath);
		let raw = "";
		try {
			if (existsSync(path)) raw = readFileSync(path, "utf8");
			this.replay(raw);
			// O_CREAT|O_APPEND with mode 0600: the file is born private in one call.
			this.fd = openSync(path, "a", 0o600);
			fchmodSync(this.fd, 0o600);
		} catch (err) {
			this.releaseLock();
			throw err;
		}
		// A torn final write has no newline: end it, so the next line does not fuse onto it.
		if (raw !== "" && !raw.endsWith("\n")) writeSync(this.fd, "\n");
		for (const requestId of this.unknownAfterRestart)
			this.write({ op: "unknown", requestId }, true);
	}

	private replay(raw: string): void {
		for (const text of raw.split("\n")) {
			let e: Line;
			try {
				e = JSON.parse(text);
			} catch {
				continue; // blank line, or a torn final write from a crash
			}
			if (typeof e?.requestId !== "string") continue;
			const item = this.items.get(e.requestId);
			if (e.op === "accept" && !item) {
				const { requestId, seq, acceptedAt } = e;
				this.items.set(requestId, {
					receipt: { requestId, seq, acceptedAt },
					text: e.text,
					channel: e.channel,
					sessionId: e.sessionId,
					status: "queued",
				});
				this.nextSeq = Math.max(this.nextSeq, seq + 1);
			} else if (item && e.op !== "accept") {
				if (e.op === "end") item.status = e.ok ? "done" : "failed";
				else item.status = e.op === "start" ? "running" : "unknown";
			}
		}
		for (const item of this.items.values()) {
			if (item.status === "queued") this.pending.push(item.receipt.requestId);
			if (item.status === "running") {
				item.status = "unknown";
				this.unknownAfterRestart.push(item.receipt.requestId);
			}
		}
	}

	/** fsync for accept and start: an accepted item is on disk, and a started one is never resent. */
	private write(line: Line, sync = false): void {
		writeSync(this.fd, `${JSON.stringify(line)}\n`);
		if (sync) fsyncSync(this.fd);
	}

	enqueue(req: QueueRequest): { receipt: Receipt; duplicate: boolean } {
		if (typeof req.requestId !== "string" || req.requestId === "") {
			throw new Error("work queue: requestId is required");
		}
		const known = this.items.get(req.requestId);
		if (known) return { receipt: known.receipt, duplicate: true };
		const receipt: Receipt = {
			requestId: req.requestId,
			seq: this.nextSeq,
			acceptedAt: Date.now(),
		};
		const channel = req.channel ?? "api";
		this.write(
			{ op: "accept", ...receipt, text: req.text, channel, sessionId: req.sessionId },
			true,
		);
		this.nextSeq++;
		this.items.set(req.requestId, {
			receipt,
			text: req.text,
			channel,
			sessionId: req.sessionId,
			status: "queued",
		});
		this.pending.push(req.requestId);
		return { receipt, duplicate: false };
	}

	/** The oldest waiting item, or null when none waits or the start throttle is full. */
	peek(): QueueItem | null {
		if (this.running >= this.startLimit) return null;
		const id = this.pending[0];
		return id === undefined ? null : (this.items.get(id) ?? null);
	}

	markStarted(requestId: string): void {
		const item = this.items.get(requestId);
		if (!item || item.status !== "queued") return;
		this.write({ op: "start", requestId }, true);
		item.status = "running";
		this.running++;
		this.pending = this.pending.filter((id) => id !== requestId);
	}

	markEnded(requestId: string, ok: boolean): void {
		const item = this.items.get(requestId);
		if (!item || item.status !== "running") return;
		this.write({ op: "end", requestId, ok });
		item.status = ok ? "done" : "failed";
		this.running--;
	}

	/** Whether any waiting item targets this session. */
	hasPendingFor(sessionId: string): boolean {
		return this.pending.some((id) => this.items.get(id)?.sessionId === sessionId);
	}

	status(requestId: string): QueueStatus | null {
		return this.items.get(requestId)?.status ?? null;
	}

	/** Close the store and release the lock. Safe to call more than once. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		closeSync(this.fd);
		this.releaseLock();
	}

	private releaseLock(): void {
		try {
			if (readFileSync(this.lockPath, "utf8").trim() === String(process.pid)) {
				unlinkSync(this.lockPath);
			}
		} catch {}
	}
}
