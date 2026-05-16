/**
 * Append-only hash-chained ledger for /goal runs.
 *
 * On-disk format: JSONL at `<baseDir>/<runId>/ledger.jsonl`.
 *
 * Each line is one entry:
 *   { seq, prev_hash, hash, ts, kind, payload, sig }
 *
 * Where:
 *   hash      = sha256(prev_hash || canonical(payload))           hex
 *   prev_hash = hash of previous entry, ZERO_HASH for the first
 *   sig       = HMAC-SHA256(key, canonical(payload))              hex
 *
 * Verification walks the file from head to tail, checking that:
 *   1. seq increments monotonically from 1
 *   2. prev_hash matches the prior entry's hash
 *   3. hash recomputes from prev_hash + canonical(payload)
 *   4. sig recomputes via HMAC over canonical(payload)
 *
 * 8GO owns this format. Tampering with any field breaks the chain.
 *
 * The HMAC key is supplied by the daemon. In production it is loaded from
 * `~/.8gent/keys/state-hmac.key` (0600). The daemon caller is expected to
 * import that primitive from `@8gent/permissions` once PR #2616 lands; for
 * now the key is passed in directly. See `HmacPrimitive` below.
 *
 * Out of scope: rotation, multi-key verification, compaction. Append-only
 * means append-only - if the ledger gets large, the daemon rotates it
 * out-of-band and starts a fresh run.
 */

import { createHash, createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { GoalEventKind } from "./types";

/** All-zero SHA-256 used as the prev_hash of the first entry. */
export const ZERO_HASH = "0".repeat(64);

export interface LedgerEntry {
	seq: number;
	prev_hash: string;
	hash: string;
	ts: number;
	kind: GoalEventKind | string;
	payload: Record<string, unknown>;
	sig: string;
}

export interface LedgerVerifyResult {
	ok: boolean;
	count: number;
	/** Sequence number at which verification failed, if any. */
	atSeq?: number;
	/** Human-readable reason for failure. */
	reason?: string;
}

export interface LedgerOpenOptions {
	runId: string;
	/** Parent directory. Final file = `<baseDir>/<runId>/ledger.jsonl`. */
	baseDir: string;
	/** HMAC key bytes. Supplied by the daemon. */
	key: Buffer;
	/** Optional clock override (tests). */
	now?: () => number;
}

export interface AppendInput {
	kind: GoalEventKind | string;
	payload: Record<string, unknown>;
	now?: number;
}

/**
 * Thin interface the ledger uses for signing + verification.
 *
 * TODO: replace with `import { sign, verify } from "@8gent/permissions"`
 * once PR #2616 (feat/go-policy-gates) lands. That package owns the
 * daemon-resident key at `~/.8gent/keys/state-hmac.key` and provides
 * `sign(payload)` / `verify({payload, sig})` over canonical JSON.
 *
 * Until then we accept the key directly via LedgerOpenOptions and use the
 * same canonical-JSON + HMAC-SHA256 contract so the on-disk format is
 * forward-compatible with PR #2616.
 */
export interface HmacPrimitive {
	sign(canonical: string): string;
	verify(canonical: string, sig: string): boolean;
}

function makeHmacPrimitive(key: Buffer): HmacPrimitive {
	return {
		sign(canonical: string): string {
			return createHmac("sha256", key).update(canonical).digest("hex");
		},
		verify(canonical: string, sig: string): boolean {
			const expected = createHmac("sha256", key).update(canonical).digest("hex");
			// Constant-time comparison.
			if (expected.length !== sig.length) return false;
			let diff = 0;
			for (let i = 0; i < expected.length; i++) {
				diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
			}
			return diff === 0;
		},
	};
}

/**
 * Canonical JSON: sorted keys at every level, no whitespace, stable across
 * platforms. Used as the input to both hash and HMAC so any reorder of keys
 * by a JSON library cannot create a verification false-positive.
 */
export function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonical).join(",")}]`;
	}
	const keys = Object.keys(value as Record<string, unknown>).sort();
	const parts: string[] = [];
	for (const k of keys) {
		const v = (value as Record<string, unknown>)[k];
		if (v === undefined) continue;
		parts.push(`${JSON.stringify(k)}:${canonical(v)}`);
	}
	return `{${parts.join(",")}}`;
}

function sha256Hex(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}

export class Ledger {
	private readonly file: string;
	private readonly hmac: HmacPrimitive;
	private readonly now: () => number;
	private seq = 0;
	private lastHash = ZERO_HASH;
	private closed = false;

	private constructor(file: string, hmac: HmacPrimitive, now: () => number) {
		this.file = file;
		this.hmac = hmac;
		this.now = now;
	}

	/**
	 * Open (or create) a ledger for a run. Throws if the directory is not
	 * writable - by design we refuse to start a /goal run that cannot persist
	 * its audit log.
	 */
	static open(opts: LedgerOpenOptions): Ledger {
		const runDir = path.join(opts.baseDir, opts.runId);
		try {
			fs.mkdirSync(runDir, { recursive: true });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(
				`Ledger.open: cannot create run directory ${runDir} - ${msg}`,
			);
		}
		// Probe writability before claiming success.
		try {
			fs.accessSync(runDir, fs.constants.W_OK);
		} catch {
			throw new Error(`Ledger.open: directory unwritable: ${runDir}`);
		}
		const file = path.join(runDir, "ledger.jsonl");
		// Touch the file with create flag so subsequent appends are
		// guaranteed to succeed.
		try {
			const fd = fs.openSync(file, "a");
			fs.closeSync(fd);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`Ledger.open: cannot open ledger file ${file} - ${msg}`);
		}
		const ledger = new Ledger(file, makeHmacPrimitive(opts.key), opts.now ?? Date.now);
		ledger.hydrateFromDisk();
		return ledger;
	}

	/**
	 * Walk the file and pick up the last seq + last hash so subsequent
	 * appends continue the chain across reopens. We do NOT re-verify on
	 * open - that's `verify()`'s job and is paid for only when asked.
	 */
	private hydrateFromDisk(): void {
		let raw: string;
		try {
			raw = fs.readFileSync(this.file, "utf8");
		} catch {
			return;
		}
		const lines = raw.trim().length === 0 ? [] : raw.trim().split("\n");
		if (lines.length === 0) return;
		const last = JSON.parse(lines[lines.length - 1]) as LedgerEntry;
		this.seq = last.seq;
		this.lastHash = last.hash;
	}

	/** Append a single entry. Synchronous fs write for deterministic ordering. */
	append(input: AppendInput): LedgerEntry {
		if (this.closed) {
			throw new Error("Ledger.append: ledger is closed");
		}
		this.seq += 1;
		const ts = input.now ?? this.now();
		const canon = canonical(input.payload ?? {});
		const hash = sha256Hex(this.lastHash + canon);
		const sig = this.hmac.sign(canon);
		const entry: LedgerEntry = {
			seq: this.seq,
			prev_hash: this.lastHash,
			hash,
			ts,
			kind: input.kind,
			payload: input.payload,
			sig,
		};
		fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
		this.lastHash = hash;
		return entry;
	}

	/** Read every entry from disk. */
	readAll(): LedgerEntry[] {
		let raw: string;
		try {
			raw = fs.readFileSync(this.file, "utf8");
		} catch {
			return [];
		}
		const lines = raw.trim().length === 0 ? [] : raw.trim().split("\n");
		return lines.map((line, idx) => {
			try {
				return JSON.parse(line) as LedgerEntry;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				throw new Error(`Ledger.readAll: malformed entry at line ${idx + 1} - ${msg}`);
			}
		});
	}

	/**
	 * Verify the chain end-to-end. Checks:
	 *   - seq starts at 1 and increments by 1
	 *   - prev_hash chains correctly
	 *   - hash recomputes from prev_hash + canonical(payload)
	 *   - sig verifies via HMAC over canonical(payload)
	 *
	 * Returns the first failure encountered or `{ ok: true }` on success.
	 */
	verify(): LedgerVerifyResult {
		const entries = this.readAll();
		let prev = ZERO_HASH;
		for (let i = 0; i < entries.length; i++) {
			const e = entries[i];
			const expectedSeq = i + 1;
			if (e.seq !== expectedSeq) {
				return {
					ok: false,
					count: entries.length,
					atSeq: e.seq,
					reason: `seq mismatch: expected ${expectedSeq}, got ${e.seq}`,
				};
			}
			if (e.prev_hash !== prev) {
				return {
					ok: false,
					count: entries.length,
					atSeq: e.seq,
					reason: `prev_hash mismatch (chain broken)`,
				};
			}
			const canon = canonical(e.payload ?? {});
			const expectedHash = sha256Hex(prev + canon);
			if (e.hash !== expectedHash) {
				return {
					ok: false,
					count: entries.length,
					atSeq: e.seq,
					reason: `hash mismatch (payload tampered or hash recomputed wrong)`,
				};
			}
			if (!this.hmac.verify(canon, e.sig)) {
				return {
					ok: false,
					count: entries.length,
					atSeq: e.seq,
					reason: `sig verification failed (wrong key or payload tampered)`,
				};
			}
			prev = e.hash;
		}
		return { ok: true, count: entries.length };
	}

	close(): void {
		this.closed = true;
	}

	get currentSeq(): number {
		return this.seq;
	}

	get headHash(): string {
		return this.lastHash;
	}
}
