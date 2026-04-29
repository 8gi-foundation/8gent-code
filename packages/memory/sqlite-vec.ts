/**
 * sqlite-vec extension loader for bun:sqlite.
 *
 * Loads the sqlite-vec dynamic library so SQL queries can use
 * vec0 virtual tables and vec_distance_cosine() for native vector search.
 *
 * On macOS the system SQLite that Bun links against is built without
 * SQLITE_ENABLE_LOAD_EXTENSION. If a Homebrew SQLite is present we point
 * Bun at it via Database.setCustomSQLite() before any Database is opened.
 *
 * If the extension cannot be loaded (unsupported platform, missing binary,
 * sandboxed runtime) callers fall back to the in-process JS cosine path.
 */

import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";

let _customSQLiteAttempted = false;
let _customSQLiteApplied = false;

/**
 * Best-effort: redirect bun:sqlite to a SQLite build that supports
 * runtime extension loading. Must be called BEFORE any Database is opened.
 *
 * Returns true if a custom SQLite was successfully configured (or already was).
 * Returns false on non-darwin platforms or when no Homebrew SQLite exists.
 */
export function ensureSqliteSupportsExtensions(): boolean {
	if (_customSQLiteApplied) return true;
	if (_customSQLiteAttempted) return false;
	_customSQLiteAttempted = true;

	if (process.platform !== "darwin") {
		// Linux + Windows Bun builds load extensions out of the box.
		_customSQLiteApplied = true;
		return true;
	}

	const candidates = [
		"/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib", // Apple Silicon Homebrew
		"/usr/local/opt/sqlite/lib/libsqlite3.dylib", // Intel Homebrew
	];

	for (const candidate of candidates) {
		if (!existsSync(candidate)) continue;
		try {
			Database.setCustomSQLite(candidate);
			_customSQLiteApplied = true;
			return true;
		} catch {
			// Already set on a previous Database open, or unsupported. Keep trying.
		}
	}
	return false;
}

export type VecLoadResult =
	| { ok: true; version: string }
	| { ok: false; reason: string };

/**
 * Try to load the sqlite-vec extension into the given Database.
 * Idempotent per-DB (the extension only needs to be loaded once).
 */
export function loadSqliteVec(db: Database): VecLoadResult {
	try {
		sqliteVec.load(db);
		const row = db
			.prepare("SELECT vec_version() AS version")
			.get() as { version: string } | null;
		return { ok: true, version: row?.version ?? "unknown" };
	} catch (err) {
		return { ok: false, reason: (err as Error).message };
	}
}

/**
 * Encode a Float32Array as the BLOB shape sqlite-vec expects for binding.
 * vec0 columns and vec_distance_cosine() both accept little-endian f32 buffers.
 */
export function encodeVector(vec: Float32Array): Buffer {
	return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}
