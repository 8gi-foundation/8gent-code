import { Database, type Statement } from "bun:sqlite";

/**
 * A bun:sqlite Database whose close() actually releases the file.
 *
 * The problem this solves: bun's Database.close() uses sqlite3_close_v2. If
 * any statement made with db.prepare() has not been finalized yet, SQLite
 * keeps the connection alive as a "zombie" until the last statement goes, so
 * the .db, -wal and -shm files stay open after close() returns. bun only
 * finalizes statements it cached itself (db.query()) or that the garbage
 * collector has already reclaimed. Every store here calls db.prepare() inside
 * its methods, so a close() straight after use always leaves the file open.
 *
 * On Linux and macOS nobody notices: unlinking an open file succeeds. On
 * Windows the file is locked, so deleting or replacing it fails with EBUSY.
 * That is what broke every store test on windows-latest at cleanup, and it is
 * the same failure a user hits when 8gent tries to remove or rotate a
 * database it has just closed.
 *
 * This subclass remembers every statement it prepares (weakly, so it never
 * keeps one alive) and finalizes the ones still live before closing. It is a
 * drop-in for `new Database(...)`: same constructor, same methods.
 *
 * A statement the garbage collector has already reclaimed needs one more
 * step. Its WeakRef is cleared when the collector marks it dead, but bun only
 * finalizes the SQLite statement when the collector later sweeps that memory,
 * and sweeping is lazy: it happens on some future allocation, not at the
 * collection. Between the two the statement is unreachable from JS yet still
 * holds the connection open. That window is what kept the file locked on
 * windows-latest when several suites shared one process (store.test.ts,
 * decision-audit): the earlier suites' garbage made a collection land
 * mid-suite, and a blocked thread never swept. So when any tracked statement
 * has been reclaimed, close() runs a synchronous full collection first,
 * which sweeps and finalizes it.
 */
export class SqliteDatabase extends Database {
	#statements = new Set<WeakRef<Statement>>();
	#sinceSweep = 0;
	/** A tracked statement was reclaimed, so it may not be finalized yet. */
	#reclaimed = false;

	// biome-ignore lint/suspicious/noExplicitAny: mirrors bun's generic signature
	override prepare(...args: Parameters<Database["prepare"]>): any {
		const stmt = super.prepare(...args);
		this.#statements.add(new WeakRef(stmt));
		// Stores prepare per call, so drop references the GC has already
		// collected (and finalized) to keep the set from growing unbounded.
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

	override close(throwOnError?: boolean): void {
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
		// Reclaimed but possibly unswept statements: sweep them now (see above).
		if (this.#reclaimed) Bun.gc(true);
		this.#reclaimed = false;
		super.close(throwOnError);
	}
}
