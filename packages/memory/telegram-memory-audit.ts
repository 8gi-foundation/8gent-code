/**
 * Content-free, append-only, hash-chained audit log for Telegram memory (C-M17, epic #4391).
 *
 * One JSON line per action: {seq, at, actor_id, chat_id, action, subject_key_hash, row_counts,
 * outcome, prev, hash}. There is no field that can hold message text or a name: the outcome is a
 * short code, row_counts is numbers, and the subject is an HMAC of the id under a local salt.
 * Each line's hash covers the previous hash, so deleting or editing a line breaks the chain and
 * `verify` says where. The log is never touched by a purge: it holds hashes and counts only.
 *
 * CLI: bun packages/memory/telegram-memory-audit.ts verify [path]
 */

import { createHash, createHmac, randomBytes } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export const GENESIS = "0".repeat(64);
const OUTCOME_RE = /^[a-z0-9_:.-]{1,64}$/;
const ACTION_RE = /^[a-z0-9_.-]{1,48}$/;

export interface AuditEntry {
	actor_id: string;
	chat_id: string;
	action: string;
	subject_key_hash: string;
	row_counts: Record<string, number>;
	outcome: string;
}

interface AuditLine extends AuditEntry {
	seq: number;
	at: string;
	prev: string;
	hash: string;
}

function digest(line: Omit<AuditLine, "hash">): string {
	return createHash("sha256")
		.update(line.prev)
		.update("\n")
		.update(JSON.stringify(line))
		.digest("hex");
}

export function ensurePrivateDir(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
}

export class AuditLog {
	private salt: Buffer;
	private lastHash = GENESIS;
	private seq = 0;

	constructor(
		private path: string,
		saltPath: string,
		private clock: () => number = Date.now,
		onRepair: (droppedBytes: number) => void = () => {},
	) {
		ensurePrivateDir(dirname(path));
		if (existsSync(saltPath)) {
			this.salt = readFileSync(saltPath);
		} else {
			this.salt = randomBytes(32);
			writeFileSync(saltPath, this.salt, { mode: 0o600 });
			chmodSync(saltPath, 0o600);
		}
		if (existsSync(path)) {
			const dropped = repairTornTail(path);
			if (dropped > 0) onRepair(dropped);
			const v = verifyAudit(path);
			if (!v.ok)
				throw new Error(`audit log chain broken at line ${v.brokenAt}; refusing to append`);
			this.lastHash = v.lastHash;
			this.seq = v.count;
		}
	}

	/** Salted hash of an id. Same id, same hash, but not reversible without the salt. */
	subjectHash(id: string): string {
		return createHmac("sha256", this.salt).update(String(id)).digest("hex");
	}

	append(entry: AuditEntry): void {
		if (!ACTION_RE.test(entry.action)) throw new Error("audit: bad action code");
		if (!OUTCOME_RE.test(entry.outcome)) throw new Error("audit: bad outcome code");
		for (const [k, v] of Object.entries(entry.row_counts)) {
			if (!/^[a-z_]{1,32}$/.test(k) || !Number.isInteger(v)) throw new Error("audit: bad count");
		}
		const body: Omit<AuditLine, "hash"> = {
			seq: this.seq + 1,
			at: new Date(this.clock()).toISOString(),
			actor_id: String(entry.actor_id),
			chat_id: String(entry.chat_id),
			action: entry.action,
			subject_key_hash: entry.subject_key_hash,
			row_counts: entry.row_counts,
			outcome: entry.outcome,
			prev: this.lastHash,
		};
		const hash = digest(body);
		appendFileSync(this.path, `${JSON.stringify({ ...body, hash })}\n`, { mode: 0o600 });
		chmodSync(this.path, 0o600);
		this.lastHash = hash;
		this.seq += 1;
	}
}

/**
 * A crash mid-append leaves a last line with no newline. If everything before it verifies, cut the
 * partial line and return how many bytes were dropped. A complete line that fails verification is
 * tampering, not a crash, and is never repaired. Returns 0 when nothing was done.
 */
export function repairTornTail(path: string): number {
	const buf = readFileSync(path);
	if (buf.length === 0 || buf[buf.length - 1] === 0x0a) return 0;
	const cut = buf.lastIndexOf(0x0a) + 1; // 0 when the only line is the torn one
	const prefix = buf.subarray(0, cut);
	const probe = `${path}.probe-${process.pid}`;
	writeFileSync(probe, prefix, { mode: 0o600 });
	const ok = verifyAudit(probe).ok;
	rmSync(probe, { force: true });
	if (!ok) return 0;
	truncateSync(path, cut);
	return buf.length - cut;
}

export interface AuditVerdict {
	ok: boolean;
	count: number;
	lastHash: string;
	brokenAt?: number;
}

/** Recompute the chain. `brokenAt` is the 1-based line that does not match. */
export function verifyAudit(path: string): AuditVerdict {
	if (!existsSync(path)) return { ok: true, count: 0, lastHash: GENESIS };
	const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
	let prev = GENESIS;
	for (let i = 0; i < lines.length; i++) {
		let parsed: AuditLine;
		try {
			parsed = JSON.parse(lines[i]) as AuditLine;
		} catch {
			return { ok: false, count: i, lastHash: prev, brokenAt: i + 1 };
		}
		const { hash, ...rest } = parsed;
		if (rest.prev !== prev || rest.seq !== i + 1 || digest(rest) !== hash) {
			return { ok: false, count: i, lastHash: prev, brokenAt: i + 1 };
		}
		prev = hash;
	}
	return { ok: true, count: lines.length, lastHash: prev };
}

if (import.meta.main) {
	const [cmd, p] = process.argv.slice(2);
	const path = p ?? `${process.env.HOME}/.8gent/memory/audit.jsonl`;
	if (cmd !== "verify") {
		console.error("usage: telegram-memory-audit.ts verify [path]");
		process.exit(2);
	}
	const v = verifyAudit(path);
	console.log(v.ok ? `OK ${v.count} line(s)` : `FAIL chain broken at line ${v.brokenAt}`);
	process.exit(v.ok ? 0 : 1);
}
