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
 */
export class SqliteDatabase extends Database {
	#statements = new Set<WeakRef<Statement>>();
	#sinceSweep = 0;

	// biome-ignore lint/suspicious/noExplicitAny: mirrors bun's generic signature
	override prepare(...args: Parameters<Database["prepare"]>): any {
		const stmt = super.prepare(...args);
		this.#statements.add(new WeakRef(stmt));
		// Stores prepare per call, so drop references the GC has already
		// collected (and finalized) to keep the set from growing unbounded.
		if (++this.#sinceSweep >= 512) {
			this.#sinceSweep = 0;
			for (const ref of this.#statements)
				if (ref.deref() === undefined) this.#statements.delete(ref);
		}
		return stmt;
	}

	override close(throwOnError?: boolean): void {
		for (const ref of this.#statements) {
			try {
				ref.deref()?.finalize();
			} catch {
				// already finalized
			}
		}
		this.#statements.clear();
		super.close(throwOnError);
	}
}
