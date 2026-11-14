/**
 * Hash chain for append-only audit records (8gi-governance#1108, gap 2).
 *
 * Each chained record carries two fields:
 *
 *   prev_hash = the `hash` of the chained record before it, or GENESIS_HASH
 *   hash      = SHA-256 hex of (prev_hash + canonicalJson(record))
 *
 * `record` is every field of the row EXCEPT prev_hash and hash. Canonical JSON
 * is JSON with object keys sorted (by UTF-16 code unit) at every depth and no
 * whitespace, so the hash covers what the record says, not how it was laid
 * out. Because prev_hash is always 64 hex characters, plain concatenation is
 * unambiguous.
 *
 * What the chain proves: editing, deleting or reordering any record after the
 * first chained one breaks verification at that record. What it does not prove:
 * that the newest records were not cut off. Tail truncation is only visible
 * against a head hash kept somewhere else, which is why verifyChain() returns
 * the head.
 *
 * Rows written before chaining existed have no hashes. They are "pre-chain",
 * tolerated only as an unbroken run at the start. A row without hashes after
 * the chain has started is reported as broken, since stripping the hashes is
 * otherwise a free way to rewrite history.
 *
 * The dependency-free JSONL writer and verifier in ledger-chain.mjs uses the
 * same rules; hash-chain.test.ts holds the two to the same output.
 */

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

/** prev_hash of the first chained record. Fixed forever: 64 zeros. */
export const GENESIS_HASH = "0".repeat(64);

/** JSON with sorted object keys at every depth and no whitespace. */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") {
		if (typeof value === "number" && !Number.isFinite(value)) {
			throw new Error(`canonicalJson: non-finite number ${value}`);
		}
		const out = JSON.stringify(value);
		if (out === undefined) throw new Error(`canonicalJson: unsupported value ${String(value)}`);
		return out;
	}
	if (Array.isArray(value)) {
		return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
	}
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj)
		.filter((k) => obj[k] !== undefined)
		.sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/** hash = SHA-256 hex of (prevHash + canonicalJson(record)). */
export function chainHash(prevHash: string, record: unknown): string {
	return createHash("sha256")
		.update(prevHash + canonicalJson(record))
		.digest("hex");
}

/** One record as stored: its own fields plus the two chain fields (null when pre-chain). */
export interface ChainEntry {
	record: unknown;
	prevHash: string | null;
	hash: string | null;
}

export type ChainReport =
	| {
			ok: true;
			/** Records seen, pre-chain included. */
			total: number;
			/** Records written before chaining, at the start. */
			preChain: number;
			/** Hash of the last chained record, GENESIS_HASH when none. Anchor it elsewhere. */
			headHash: string;
	  }
	| {
			ok: false;
			total: number;
			preChain: number;
			/** 0-based index of the first broken record. */
			index: number;
			reason: string;
	  };

/** Walk entries in order and return ok, or the first broken index. */
export function verifyChain(entries: Iterable<ChainEntry>): ChainReport {
	let total = 0;
	let preChain = 0;
	let chainStarted = false;
	let expectedPrev = GENESIS_HASH;
	let broken: { index: number; reason: string } | null = null;

	for (const entry of entries) {
		const index = total;
		total += 1;
		if (broken) continue;

		const hasPrev = entry.prevHash != null && entry.prevHash !== "";
		const hasHash = entry.hash != null && entry.hash !== "";
		if (!hasPrev && !hasHash) {
			if (chainStarted) {
				broken = { index, reason: "record has no hash but the chain had already started" };
			} else {
				preChain += 1;
			}
			continue;
		}
		if (!hasPrev || !hasHash) {
			broken = { index, reason: "record has only one of prev_hash and hash" };
			continue;
		}
		chainStarted = true;
		if (entry.prevHash !== expectedPrev) {
			broken = {
				index,
				reason:
					"prev_hash does not match the record before it (record deleted, inserted or reordered)",
			};
			continue;
		}
		let recomputed: string;
		try {
			recomputed = chainHash(entry.prevHash as string, entry.record);
		} catch (err) {
			broken = { index, reason: (err as Error).message };
			continue;
		}
		if (recomputed !== entry.hash) {
			broken = {
				index,
				reason: "hash does not match the record (record changed after it was written)",
			};
			continue;
		}
		expectedPrev = entry.hash as string;
	}

	if (broken) return { ok: false, total, preChain, ...broken };
	return { ok: true, total, preChain, headHash: expectedPrev };
}

// ============================================
// SQLite helpers for the append-only stores
// ============================================

/**
 * Migration: add prev_hash and hash columns to `table` when missing.
 * Only ADD COLUMN, never a rewrite, so existing rows stay as they were (and
 * read back as pre-chain). Safe to run on every open.
 */
export function addChainColumns(db: Database, table: string): void {
	const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
	const names = new Set(cols.map((c) => c.name));
	if (!names.has("prev_hash")) db.exec(`ALTER TABLE ${table} ADD COLUMN prev_hash TEXT`);
	if (!names.has("hash")) db.exec(`ALTER TABLE ${table} ADD COLUMN hash TEXT`);
}

/** Hash of the newest chained row, or GENESIS_HASH when nothing is chained yet. */
export function chainHead(db: Database, table: string): string {
	const row = db
		.prepare(`SELECT hash FROM ${table} WHERE hash IS NOT NULL ORDER BY rowid DESC LIMIT 1`)
		.get() as { hash: string } | null;
	return row?.hash ?? GENESIS_HASH;
}

/**
 * Verify a table in insertion (rowid) order. `columns` are the record fields
 * that were hashed, the same list the writer used.
 */
export function verifyTable(db: Database, table: string, columns: readonly string[]): ChainReport {
	const rows = db
		.prepare(
			`SELECT ${[...columns, "prev_hash", "hash"].join(", ")} FROM ${table} ORDER BY rowid ASC`,
		)
		.all() as Array<Record<string, unknown>>;
	return verifyChain(
		rows.map((row) => {
			const record: Record<string, unknown> = {};
			for (const c of columns) record[c] = row[c];
			return {
				record,
				prevHash: (row.prev_hash as string | null) ?? null,
				hash: (row.hash as string | null) ?? null,
			};
		}),
	);
}
