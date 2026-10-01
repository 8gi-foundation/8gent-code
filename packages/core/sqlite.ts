import { Database, type Statement } from "bun:sqlite";

/**
 * A bun:sqlite Database whose close() actually releases the file.
 *
 * The problem this solves: bun's Database.close() uses sqlite3_close_v2. If
 * any statement made with db.prepare() has not been finalized yet, SQLite
 * keeps the connection alive as a "zombie" until the last statement goes, so
 * the .db, -wal and -shm files stay open after close() returns. bun only
 * finalizes the statements its own query() cache holds (at most 20) or that
 * the garbage collector has already reclaimed and swept. A store that calls
 * db.prepare() inside its methods therefore leaves the file open after
 * close().
 *
 * On Linux and macOS nobody notices: unlinking an open file succeeds. On
 * Windows the file is locked, so deleting or replacing it fails with EBUSY.
 * That is what broke the store tests on windows-latest at cleanup, and it is
 * the same failure a user hits when 8gent tries to remove or rotate a
 * database it has just closed.
 *
 * Three layers, cheapest first:
 *
 * 1. cached(sql): one prepared statement per SQL text, reused across calls
 *    and finalized by close(). A store that uses it for every query never
 *    depends on the collector. MemoryStore does this.
 * 2. prepare() is tracked weakly (so it never keeps a statement alive), and
 *    close() finalizes every tracked statement that is still live.
 * 3. A statement the collector has already reclaimed needs one more step. Its
 *    WeakRef clears when the collector marks it dead, but bun finalizes the
 *    SQLite statement only when that memory is swept, and sweeping is lazy.
 *    Between the two, the statement is unreachable from JS yet still holds
 *    the connection open. On Windows only, close() then runs a synchronous
 *    full collection to sweep it (see reclaimSweep). Elsewhere the open file
 *    harms nothing and the collector closes it on its next sweep.
 */

/**
 * Policy for layer 3. A full collection costs about 30 ms on a 170 MB heap
 * and blocks the event loop, so it runs only where a lingering handle breaks
 * something (Windows), and at most once per `minIntervalMs` per process.
 * Tests switch it on to exercise the path on every platform.
 */
export const reclaimSweep = {
	enabled: process.platform === "win32",
	minIntervalMs: 3000,
	lastRunAt: Number.NEGATIVE_INFINITY,
	runs: 0,
};

function sweepReclaimedStatements(): void {
	if (!reclaimSweep.enabled) return;
	const now = performance.now();
	if (now - reclaimSweep.lastRunAt < reclaimSweep.minIntervalMs) return;
	reclaimSweep.lastRunAt = now;
	reclaimSweep.runs++;
	// true = synchronous full collection, which also sweeps. gc(false) does
	// not, and leaves the reclaimed statements unfinalized.
	Bun.gc(true);
}

/** Past this many distinct SQL texts, cached() stops caching (layer 2 still applies). */
const MAX_CACHED_STATEMENTS = 500;

export class SqliteDatabase extends Database {
	#statements = new Set<WeakRef<Statement>>();
	#sinceSweep = 0;
	/** A tracked statement was reclaimed, so it may not be finalized yet. */
	#reclaimed = false;
	#cache = new Map<string, Statement>();

	// biome-ignore lint/suspicious/noExplicitAny: mirrors bun's generic signature
	override prepare(...args: Parameters<Database["prepare"]>): any {
		const stmt = super.prepare(...args);
		this.#statements.add(new WeakRef(stmt));
		// Stores prepare per call, so drop references the GC has already
		// collected to keep the set from growing unbounded. A dropped one may
		// still be unswept, so close() must still sweep: remember that.
		if (++this.#sinceSweep >= 512) {
			this.#sinceSweep = 0;
			for (const ref of this.#statements)
				if (ref.deref() === undefined) {
					this.#statements.delete(ref);
					this.#reclaimed = true;
				}
		}
		return stmt;
	}

	/**
	 * Like query(), without bun's 20-statement cap: one statement per SQL
	 * text, reused by every call and finalized by close(). Only for SQL whose
	 * text is fixed (values go in placeholders), so the set stays small.
	 */
	cached(sql: string): Statement {
		const hit = this.#cache.get(sql);
		// isFinalized is real at runtime but missing from bun-types.
		if (hit && !(hit as unknown as { isFinalized: boolean }).isFinalized) return hit;
		if (!hit && this.#cache.size >= MAX_CACHED_STATEMENTS) return this.prepare(sql);
		const stmt = super.prepare(sql);
		this.#cache.set(sql, stmt);
		return stmt;
	}

	override close(throwOnError?: boolean): void {
		for (const stmt of this.#cache.values()) {
			try {
				stmt.finalize();
			} catch {
				// already finalized
			}
		}
		this.#cache.clear();
		for (const ref of this.#statements) {
			const stmt = ref.deref();
			if (stmt === undefined) {
				this.#reclaimed = true;
				continue;
			}
			try {
				stmt.finalize();
			} catch {
				// already finalized
			}
		}
		this.#statements.clear();
		if (this.#reclaimed) sweepReclaimedStatements();
		this.#reclaimed = false;
		super.close(throwOnError);
	}
}
