/**
 * Make db.close() actually release the file (#3814).
 *
 * bun:sqlite close() is sqlite3_close_v2: it defers while any prepared
 * statement is alive, and statements made with db.prepare() or db.query() live
 * until the garbage collector finalizes them. POSIX does not care, but Windows
 * keeps the file locked, so the next unlink or rm fails with EBUSY. This
 * records the statements the db hands out and finalizes the live ones just
 * before close.
 *
 * References are weak: a long-lived store that prepares inline on every call
 * must not have its statements pinned until close, so the garbage collector can
 * still reclaim any statement nobody holds. Dead references are pruned each
 * time the record doubles, which keeps the record bounded by the live set.
 */
import type { Database } from "bun:sqlite";

type Statement = ReturnType<Database["prepare"]>;

const PRUNE_FLOOR = 64;
const tracked = new WeakMap<Database, Set<WeakRef<Statement>>>();

/** Number of statement references currently recorded for db (live or not yet pruned). Test hook. */
export function trackedCount(db: Database): number {
	return tracked.get(db)?.size ?? 0;
}

export function trackStatements<T extends Database>(db: T): T {
	const refs = new Set<WeakRef<Statement>>();
	tracked.set(db, refs);
	let pruneAt = PRUNE_FLOOR;

	const record = (stmt: Statement): void => {
		refs.add(new WeakRef(stmt));
		if (refs.size < pruneAt) return;
		for (const ref of refs) if (ref.deref() === undefined) refs.delete(ref);
		pruneAt = Math.max(PRUNE_FLOOR, refs.size * 2);
	};

	const prepare = db.prepare.bind(db) as Database["prepare"];
	const query = db.query.bind(db) as Database["query"];
	const close = db.close.bind(db) as Database["close"];
	(db as { prepare: Database["prepare"] }).prepare = ((
		...args: Parameters<Database["prepare"]>
	) => {
		const stmt = prepare(...args);
		record(stmt);
		return stmt;
	}) as Database["prepare"];
	(db as { query: Database["query"] }).query = ((...args: Parameters<Database["query"]>) => {
		const stmt = query(...args);
		record(stmt as unknown as Statement);
		return stmt;
	}) as Database["query"];
	(db as { close: Database["close"] }).close = ((...args: Parameters<Database["close"]>) => {
		for (const ref of refs) {
			try {
				ref.deref()?.finalize();
			} catch {
				/* already finalized */
			}
		}
		refs.clear();
		return close(...args);
	}) as Database["close"];
	return db;
}
