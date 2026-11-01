/**
 * Effect ledger, keyed `<conversation>:<call id>`, in the run's SQLite file (#4883). Write-ahead:
 * intent (key, tool, args hash) before the effect, `done` with the result after; a `done` row is
 * returned, never re-run. A row left `started` re-runs only if the target dedupes by key, else a
 * person looks at it. States: intent -> started (claimed) -> done. bun:sqlite (the Node build
 * aliases it). Holds a hash and a short result, never arguments.
 */
import { Database } from "bun:sqlite";
import { preparePrivateFile } from "./storage.js";

export interface EffectRow {
	key: string;
	tool: string;
	status: "intent" | "started" | "done";
	result: string | null;
}

const COLS = "key, tool, state AS status, result";
const changed = (r: unknown): boolean => Number((r as { changes: number | bigint }).changes) === 1;

export class EffectLedger {
	private db: Database;

	constructor(
		file: string,
		private onSql?: (label: string) => void,
	) {
		preparePrivateFile(file);
		this.db = new Database(file);
		this.q("pragma", () =>
			this.db.exec(
				"PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;",
			),
		);
		this.q("create", () =>
			this.db.exec(
				`CREATE TABLE IF NOT EXISTS eight_effects (
					key TEXT PRIMARY KEY, tool TEXT NOT NULL, args_hash TEXT NOT NULL DEFAULT '',
					state TEXT NOT NULL, result TEXT, at INTEGER NOT NULL)`,
			),
		);
	}

	private q<T>(label: string, f: () => T): T {
		this.onSql?.(`ledger:${label}:before`);
		const out = f();
		this.onSql?.(`ledger:${label}:after`);
		return out;
	}

	get(key: string): EffectRow | undefined {
		return this.q(
			"get",
			() =>
				(this.db
					.prepare(`SELECT ${COLS} FROM eight_effects WHERE key = ?`)
					.get(key) as EffectRow | null) ?? undefined,
		);
	}

	/** Write-ahead intent. True when this call created the row. */
	intent(key: string, tool: string, argsHash = ""): boolean {
		return this.q("intent", () =>
			changed(
				this.db
					.prepare(
						"INSERT OR IGNORE INTO eight_effects (key, tool, args_hash, state, result, at) VALUES (?, ?, ?, 'intent', NULL, ?)",
					)
					.run(key, tool, argsHash, Date.now()),
			),
		);
	}

	/** Atomic claim: one UPDATE, won by exactly one caller (changes() = 1). */
	claim(key: string): boolean {
		return this.q("claim", () =>
			changed(
				this.db
					.prepare("UPDATE eight_effects SET state = 'started' WHERE key = ? AND state = 'intent'")
					.run(key),
			),
		);
	}

	/** Intent, then claim. True only for the one caller that may run the effect. */
	start(key: string, tool: string, argsHash = ""): boolean {
		this.intent(key, tool, argsHash);
		return this.claim(key);
	}

	done(key: string, result: string): void {
		this.q("done", () =>
			this.db
				.prepare("UPDATE eight_effects SET state = 'done', result = ? WHERE key = ?")
				.run(result, key),
		);
	}

	/** Calls cut off mid-effect and not rerun: what a person must look at. */
	unresolved(): EffectRow[] {
		return this.db
			.prepare(`SELECT ${COLS} FROM eight_effects WHERE state = 'started'`)
			.all() as EffectRow[];
	}

	close(): void {
		this.db.close();
	}
}
