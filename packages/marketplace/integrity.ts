/**
 * 8gent App Marketplace - Integrity (SHA-256) helpers
 *
 * Builds and verifies the `INTEGRITY.json` file embedded in every
 * `.8gent-app.tar.gz` archive. The integrity contract is documented
 * in docs/specs/APP-ARCHIVE-FORMAT.md Section 3.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface IntegrityFile {
	algorithm: "sha256";
	files: Record<string, string>;
	rootHash: string;
}

export const INTEGRITY_FILENAME = "INTEGRITY.json";

/** SHA-256 of a file on disk, hex-encoded. */
export function hashFile(filePath: string): string {
	const buf = fs.readFileSync(filePath);
	return createHash("sha256").update(buf).digest("hex");
}

/** SHA-256 of a string buffer, hex-encoded. */
export function hashBuffer(data: Buffer | string): string {
	return createHash("sha256").update(data).digest("hex");
}

/**
 * Walk a directory and return all regular files relative to `root`.
 * Sorted lexicographically so output is reproducible.
 */
export function listFiles(root: string, exclude: Set<string> = new Set()): string[] {
	const out: string[] = [];
	function walk(dir: string, rel: string) {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		for (const e of entries) {
			const childRel = rel ? `${rel}/${e.name}` : e.name;
			if (exclude.has(childRel)) continue;
			const full = path.join(dir, e.name);
			if (e.isDirectory()) {
				walk(full, childRel);
			} else if (e.isFile()) {
				out.push(childRel);
			}
		}
	}
	walk(root, "");
	out.sort();
	return out;
}

/**
 * Compute the canonical root hash from a sorted file→hash map.
 * Stable across runs so that the same source produces the same value.
 */
export function computeRootHash(files: Record<string, string>): string {
	const entries = Object.keys(files)
		.sort()
		.map((k) => [k, files[k]] as const);
	const canonical = JSON.stringify(entries);
	return hashBuffer(canonical);
}

/**
 * Build an `IntegrityFile` for every regular file under `root`,
 * skipping `INTEGRITY.json` itself.
 */
export function buildIntegrity(root: string): IntegrityFile {
	const files = listFiles(root, new Set([INTEGRITY_FILENAME]));
	const map: Record<string, string> = {};
	for (const rel of files) {
		map[rel] = hashFile(path.join(root, rel));
	}
	return {
		algorithm: "sha256",
		files: map,
		rootHash: computeRootHash(map),
	};
}

/**
 * Write `INTEGRITY.json` into `root`. Returns the integrity object.
 * Pretty-printed with stable key ordering for reproducibility.
 */
export function writeIntegrity(root: string): IntegrityFile {
	const integrity = buildIntegrity(root);
	const sorted: IntegrityFile = {
		algorithm: integrity.algorithm,
		files: Object.fromEntries(
			Object.keys(integrity.files)
				.sort()
				.map((k) => [k, integrity.files[k]]),
		),
		rootHash: integrity.rootHash,
	};
	const out = path.join(root, INTEGRITY_FILENAME);
	fs.writeFileSync(out, `${JSON.stringify(sorted, null, 2)}\n`);
	return sorted;
}

export interface IntegrityVerifyResult {
	ok: boolean;
	errors: string[];
}

/**
 * Read `INTEGRITY.json` from `root`, recompute every per-file hash and
 * the root hash, and report mismatches.
 */
export function verifyIntegrity(root: string): IntegrityVerifyResult {
	const errors: string[] = [];
	const integrityPath = path.join(root, INTEGRITY_FILENAME);
	if (!fs.existsSync(integrityPath)) {
		return { ok: false, errors: [`missing ${INTEGRITY_FILENAME}`] };
	}

	let parsed: IntegrityFile;
	try {
		parsed = JSON.parse(fs.readFileSync(integrityPath, "utf-8")) as IntegrityFile;
	} catch (err) {
		return { ok: false, errors: [`failed to parse ${INTEGRITY_FILENAME}: ${err}`] };
	}

	if (parsed.algorithm !== "sha256") {
		errors.push(`unsupported algorithm: ${parsed.algorithm}`);
	}

	const actualFiles = listFiles(root, new Set([INTEGRITY_FILENAME]));
	const declared = new Set(Object.keys(parsed.files));
	const actual = new Set(actualFiles);

	for (const f of actual) {
		if (!declared.has(f)) errors.push(`extra file not in INTEGRITY.json: ${f}`);
	}
	for (const f of declared) {
		if (!actual.has(f)) errors.push(`declared file missing on disk: ${f}`);
	}

	for (const rel of actualFiles) {
		const expected = parsed.files[rel];
		if (!expected) continue;
		const actualHash = hashFile(path.join(root, rel));
		if (actualHash !== expected) {
			errors.push(`hash mismatch for ${rel}`);
		}
	}

	const recomputedRoot = computeRootHash(parsed.files);
	if (recomputedRoot !== parsed.rootHash) {
		errors.push("rootHash does not match files map");
	}

	return { ok: errors.length === 0, errors };
}
