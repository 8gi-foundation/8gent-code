/**
 * bun:sqlite on Node (#node-runnable). One adapter over node:sqlite (Node 22.5+),
 * covering the surface 8gent uses: new Database(path, opts), query/prepare, run,
 * exec, transaction, close, and Statement get/all/run/values. Only the Node build
 * (scripts/build-node.ts) aliases "bun:sqlite" here; the Bun path is unchanged.
 */
import { createRequire } from "node:module";

// biome-ignore lint/suspicious/noExplicitAny: the Node boundary mirrors Bun's loose shapes
type Loose = any;

type Bindable = string | number | bigint | Uint8Array | null;
const nodeRequire = createRequire(import.meta.url);

function loadNodeSqlite(): {
	DatabaseSync: new (path: string, opts?: Record<string, unknown>) => Loose;
} {
	try {
		return nodeRequire("node:sqlite");
	} catch {
		throw new Error(
			`8gent on Node needs Node 22.5 or newer for its local database (found ${process.version}). Upgrade Node, or install Bun.`,
		);
	}
}

function norm(v: unknown): Bindable {
	if (v === undefined || v === null) return null;
	if (typeof v === "boolean") return v ? 1 : 0;
	if (v instanceof Date) return v.toISOString();
	if (typeof v === "object" && !(v instanceof Uint8Array)) return JSON.stringify(v);
	return v as Bindable;
}

/** bun:sqlite accepts (a, b), ([a, b]) or ({ $name: v }). */
function bind(args: unknown[]): { named?: Record<string, Bindable>; positional: Bindable[] } {
	if (args.length === 1 && Array.isArray(args[0])) return { positional: args[0].map(norm) };
	if (
		args.length === 1 &&
		args[0] !== null &&
		typeof args[0] === "object" &&
		!(args[0] instanceof Uint8Array) &&
		!(args[0] instanceof Date)
	) {
		const named: Record<string, Bindable> = {};
		for (const [k, v] of Object.entries(args[0] as Record<string, unknown>)) named[k] = norm(v);
		return { named, positional: [] };
	}
	return { positional: args.map(norm) };
}

/** True when `sql` holds more than one statement (a `;` followed by more SQL, outside strings/comments). */
export function hasSeveralStatements(sql: string): boolean {
	let i = 0;
	let sawEnd = false;
	while (i < sql.length) {
		const c = sql[i];
		const two = sql.slice(i, i + 2);
		if (two === "--") {
			const n = sql.indexOf("\n", i);
			i = n === -1 ? sql.length : n + 1;
		} else if (two === "/*") {
			const n = sql.indexOf("*/", i + 2);
			i = n === -1 ? sql.length : n + 2;
		} else if (c === "'" || c === '"' || c === "`") {
			let j = i + 1;
			while (j < sql.length && !(sql[j] === c && sql[j + 1] !== c)) j += sql[j] === c ? 2 : 1;
			if (sawEnd) return true;
			i = j + 1;
		} else if (c === "[") {
			const n = sql.indexOf("]", i);
			if (sawEnd) return true;
			i = n === -1 ? sql.length : n + 1;
		} else if (c === ";") {
			sawEnd = true;
			i++;
		} else if (/\s/.test(c)) {
			i++;
		} else {
			if (sawEnd) return true;
			i++;
		}
	}
	return false;
}

export class Statement<R = Loose> {
	private readonly stmt: Loose;
	constructor(stmt: Loose) {
		this.stmt = stmt;
	}
	private call(method: "get" | "all" | "run", args: unknown[]): Loose {
		const { named, positional } = bind(args);
		return named ? this.stmt[method](named, ...positional) : this.stmt[method](...positional);
	}
	get(...args: unknown[]): R | null {
		return (this.call("get", args) as R | undefined) ?? null;
	}
	all(...args: unknown[]): R[] {
		return this.call("all", args) as R[];
	}
	run(...args: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
		const r = this.call("run", args);
		return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
	}
	values(...args: unknown[]): unknown[][] {
		const rows = this.call("all", args) as Record<string, unknown>[];
		return rows.map((r) => Object.values(r));
	}
	finalize(): void {}
}

export class Database {
	private readonly db: Loose;
	private readonly cache = new Map<string, Statement>();
	constructor(
		filename = ":memory:",
		opts: { readonly?: boolean; create?: boolean; readwrite?: boolean } = {},
	) {
		const { DatabaseSync } = loadNodeSqlite();
		this.db = new DatabaseSync(filename, { readOnly: opts.readonly === true });
	}
	prepare<R = Loose>(sql: string): Statement<R> {
		return new Statement<R>(this.db.prepare(sql));
	}
	query<R = Loose>(sql: string): Statement<R> {
		let s = this.cache.get(sql);
		if (!s) {
			s = this.prepare(sql);
			this.cache.set(sql, s);
		}
		return s as Statement<R>;
	}
	exec(sql: string): void {
		this.db.exec(sql);
	}
	run(sql: string, ...args: unknown[]) {
		if (hasSeveralStatements(sql)) {
			// bun:sqlite runs every statement here; prepare() would silently run only the first.
			if (args.length > 0)
				throw new Error("db.run: bound parameters cannot be used with several statements");
			this.db.exec(sql);
			const r = this.db.prepare("SELECT changes() AS changes, last_insert_rowid() AS id").get();
			return { changes: Number(r.changes), lastInsertRowid: r.id };
		}
		return this.prepare(sql).run(...args);
	}
	private depth = 0;
	transaction<F extends (...a: Loose[]) => Loose>(
		fn: F,
	): F & { deferred: F; immediate: F; exclusive: F } {
		// Like Bun: the outermost call is BEGIN/COMMIT, a nested call is a SAVEPOINT.
		const wrap = (begin: string) =>
			((...a: unknown[]) => {
				const nested = this.depth > 0;
				const sp = `sp_${this.depth}`;
				this.db.exec(nested ? `SAVEPOINT ${sp}` : begin);
				this.depth++;
				try {
					const r = fn(...a);
					this.depth--;
					this.db.exec(nested ? `RELEASE ${sp}` : "COMMIT");
					return r;
				} catch (e) {
					this.depth--;
					try {
						this.db.exec(nested ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : "ROLLBACK");
					} catch {}
					throw e;
				}
			}) as unknown as F;
		const t = wrap("BEGIN") as F & { deferred: F; immediate: F; exclusive: F };
		t.deferred = t;
		t.immediate = wrap("BEGIN IMMEDIATE");
		t.exclusive = wrap("BEGIN EXCLUSIVE");
		return t;
	}
	serialize(): Uint8Array {
		throw new Error("Database.serialize is not available on the Node build of 8gent");
	}
	loadExtension(): void {
		throw new Error("SQLite extensions are not available on the Node build of 8gent");
	}
	close(): void {
		this.cache.clear();
		this.db.close();
	}
}

export default Database;
