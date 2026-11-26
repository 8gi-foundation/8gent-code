#!/usr/bin/env node
/**
 * ledger-chain.mjs - hash-chained JSONL ledgers. No dependencies: node:crypto
 * and node:fs only, runs under node or bun. Copy it anywhere.
 *
 * Line format: one JSON object per line. The writer adds two fields:
 *
 *   {"...your fields...","prev_hash":"<64 hex>","hash":"<64 hex>"}
 *
 *   prev_hash = hash of the previous chained line, or GENESIS (64 zeros)
 *   hash      = sha256 hex of (prev_hash + canonical JSON of the object
 *               without prev_hash and hash)
 *
 * Canonical JSON: object keys sorted at every depth, no whitespace. The hash
 * covers what a line says, not its spacing. Lines with neither field at the
 * top of a file are "pre-chain" (written before chaining) and tolerated; a
 * line without hashes after the chain starts is broken. Blank lines are
 * skipped. Cutting lines off the end is only visible against a head hash kept
 * elsewhere; `verify` prints the head for that.
 *
 * Same rules as packages/audit/hash-chain.ts; hash-chain.test.ts checks both
 * give the same hashes.
 *
 * Usage:
 *   node ledger-chain.mjs append <file> '<json object>'   (or the object on stdin)
 *   node ledger-chain.mjs verify <file>
 * Exit: 0 ok, 2 broken, 1 usage or I/O error.
 */

import { createHash } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	realpathSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { fileURLToPath } from "node:url";

export const GENESIS_HASH = "0".repeat(64);

export function canonicalJson(value) {
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
	const keys = Object.keys(value)
		.filter((k) => value[k] !== undefined)
		.sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

export function chainHash(prevHash, record) {
	return createHash("sha256")
		.update(prevHash + canonicalJson(record))
		.digest("hex");
}

function isPlainObject(v) {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Split a parsed line into its record and chain fields. */
function split(obj) {
	const { prev_hash = null, hash = null, ...record } = obj;
	return { record, prevHash: prev_hash, hash };
}

/** Hash of the last chained line in `text`, or GENESIS_HASH. */
export function headOf(text) {
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (!line) continue;
		const obj = JSON.parse(line);
		if (isPlainObject(obj) && typeof obj.hash === "string" && obj.hash) return obj.hash;
		return GENESIS_HASH;
	}
	return GENESIS_HASH;
}

/** The line (no trailing newline) to append after a chain whose head is `prevHash`. */
export function sealLine(prevHash, record) {
	if (!isPlainObject(record)) throw new Error("ledger record must be a JSON object");
	if ("prev_hash" in record || "hash" in record) {
		throw new Error("ledger record must not carry prev_hash or hash; the writer adds them");
	}
	return JSON.stringify({ ...record, prev_hash: prevHash, hash: chainHash(prevHash, record) });
}

function withLock(file, fn) {
	const lock = `${file}.lock`;
	const deadline = Date.now() + 10_000;
	for (;;) {
		try {
			closeSync(openSync(lock, "wx"));
			break;
		} catch (err) {
			if (err.code !== "EEXIST") throw err;
			try {
				// A lock older than 30 s belongs to a writer that died.
				if (Date.now() - statSync(lock).mtimeMs > 30_000) unlinkSync(lock);
			} catch {}
			if (Date.now() > deadline) throw new Error(`could not take ${lock} within 10 s`);
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
		}
	}
	try {
		return fn();
	} finally {
		try {
			unlinkSync(lock);
		} catch {}
	}
}

/** Append `record` to `file` as a chained line. Returns the new head hash. */
export function appendChained(file, record) {
	return withLock(file, () => {
		const text = existsSync(file) ? readFileSync(file, "utf8") : "";
		const line = sealLine(headOf(text), record);
		const sep = text.length > 0 && !text.endsWith("\n") ? "\n" : "";
		appendFileSync(file, `${sep}${line}\n`);
		return JSON.parse(line).hash;
	});
}

/**
 * Verify ledger text. Returns
 *   { ok: true, total, preChain, headHash }
 *   { ok: false, total, preChain, index, line, reason }
 * where index is the 0-based record index and line the 1-based line number.
 */
export function verifyLedger(text) {
	let total = 0;
	let preChain = 0;
	let started = false;
	let expectedPrev = GENESIS_HASH;
	const lines = text.split("\n");
	for (let n = 0; n < lines.length; n++) {
		const raw = lines[n].trim();
		if (!raw) continue;
		const index = total;
		total += 1;
		const fail = (reason) => ({ ok: false, total, preChain, index, line: n + 1, reason });
		let obj;
		try {
			obj = JSON.parse(raw);
		} catch {
			return fail("line is not valid JSON");
		}
		if (!isPlainObject(obj)) return fail("line is not a JSON object");
		const { record, prevHash, hash } = split(obj);
		if (!prevHash && !hash) {
			if (started) return fail("line has no hash but the chain had already started");
			preChain += 1;
			continue;
		}
		if (!prevHash || !hash) return fail("line has only one of prev_hash and hash");
		started = true;
		if (prevHash !== expectedPrev) {
			return fail(
				"prev_hash does not match the line before it (line deleted, inserted or reordered)",
			);
		}
		if (chainHash(prevHash, record) !== hash) {
			return fail("hash does not match the line (line changed after it was written)");
		}
		expectedPrev = hash;
	}
	return { ok: true, total, preChain, headHash: expectedPrev };
}

function main(argv) {
	const [cmd, file, json] = argv;
	if (cmd === "verify" && file) {
		const r = verifyLedger(readFileSync(file, "utf8"));
		if (r.ok) {
			console.log(`ok: ${r.total} lines (${r.preChain} pre-chain), head ${r.headHash}`);
			return 0;
		}
		console.error(`broken at line ${r.line} (record ${r.index}): ${r.reason}`);
		return 2;
	}
	if (cmd === "append" && file) {
		const input = json ?? readFileSync(0, "utf8");
		console.log(appendChained(file, JSON.parse(input)));
		return 0;
	}
	console.error("usage: ledger-chain.mjs append <file> [json] | verify <file>");
	return 1;
}

if (
	process.argv[1] &&
	realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
	try {
		process.exit(main(process.argv.slice(2)));
	} catch (err) {
		console.error(`error: ${err.message}`);
		process.exit(1);
	}
}
