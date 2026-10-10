/**
 * Make db.close() actually release the file (#3814).
 *
 * bun:sqlite close() is sqlite3_close_v2: it defers while any prepared
 * statement is alive, and statements made with db.prepare() or db.query() live until the
 * garbage collector finalizes them. POSIX does not care, but Windows keeps the
 * file locked, so the next unlink or rm fails with EBUSY. This records every
 * statement db.prepare() and db.query() hand out and finalizes them all just before close.
 */
import type { Database } from "bun:sqlite";

type Statement = ReturnType<Database["prepare"]>;

export function trackStatements<T extends Database>(db: T): T {
	const live = new Set<Statement>();
	const prepare = db.prepare.bind(db) as Database["prepare"];
	const query = db.query.bind(db) as Database["query"];
	const close = db.close.bind(db) as Database["close"];
	(db as { prepare: Database["prepare"] }).prepare = ((
		...args: Parameters<Database["prepare"]>
	) => {
		const stmt = prepare(...args);
		live.add(stmt);
		return stmt;
	}) as Database["prepare"];
	(db as { query: Database["query"] }).query = ((...args: Parameters<Database["query"]>) => {
		const stmt = query(...args);
		live.add(stmt as unknown as Statement);
		return stmt;
	}) as Database["query"];
	(db as { close: Database["close"] }).close = ((...args: Parameters<Database["close"]>) => {
		for (const stmt of live) {
			try {
				stmt.finalize();
			} catch {
				/* already finalized */
			}
		}
		live.clear();
		return close(...args);
	}) as Database["close"];
	return db;
}
