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
 */

import {
	closeSync,
	existsSync,
	fchmodSync,
	fsyncSync,
	openSync,
	readFileSync,
	writeSync,
} from "node:fs";
import { cpus } from "node:os";

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

export class WorkQueue {
	private items = new Map<string, QueueItem>();
	/** requestIds waiting to start, oldest first. */
	private pending: string[] = [];
	private fd: number;
	private nextSeq = 1;
	private running = 0;
	readonly startLimit: number;
	/** Items that were in flight when the previous process stopped. Reported, never resent. */
	readonly unknownAfterRestart: string[] = [];

	constructor(
		readonly path: string,
		opts: { maxSessions: number; startLimit?: number },
	) {
		this.startLimit = startLimitFor(opts.maxSessions, opts.startLimit);
		if (existsSync(path)) this.replay(readFileSync(path, "utf8"));
		// O_CREAT|O_APPEND with mode 0600: the file is born private in one call.
		this.fd = openSync(path, "a", 0o600);
		fchmodSync(this.fd, 0o600);
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

	close(): void {
		closeSync(this.fd);
	}
}
