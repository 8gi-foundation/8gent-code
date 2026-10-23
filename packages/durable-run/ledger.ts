/**
 * Effect ledger: the outside effects of a run, keyed by `<conversation>:<call id>`, in the same
 * SQLite file as the run (#4883). Pi Durable decides whether an interrupted tool reruns; this
 * table decides whether the EFFECT may run again: a `done` row is returned, never re-run.
 * Synchronous node:sqlite, which Bun and Node 22 both ship. Holds hashes and a short result, never
 * arguments.
 */
import { DatabaseSync } from "node:sqlite";
import { preparePrivateFile } from "./storage.js";

export interface EffectRow {
	key: string;
	tool: string;
	status: "started" | "done";
	result: string | null;
}

export class EffectLedger {
	private db: DatabaseSync;

	constructor(file: string) {
		preparePrivateFile(file);
		this.db = new DatabaseSync(file);
		this.db.exec(
			"PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;",
		);
		this.db.exec(
			`CREATE TABLE IF NOT EXISTS eight_effects (
				key TEXT PRIMARY KEY, tool TEXT NOT NULL, status TEXT NOT NULL, result TEXT, at INTEGER NOT NULL)`,
		);
	}

	get(key: string): EffectRow | undefined {
		return this.db
			.prepare("SELECT key, tool, status, result FROM eight_effects WHERE key = ?")
			.get(key) as EffectRow | undefined;
	}

	/** Intent: written (and synced) before the effect runs. Idempotent. */
	start(key: string, tool: string): void {
		this.db
			.prepare(
				"INSERT OR IGNORE INTO eight_effects (key, tool, status, result, at) VALUES (?, ?, 'started', NULL, ?)",
			)
			.run(key, tool, Date.now());
	}

	done(key: string, result: string): void {
		this.db
			.prepare("UPDATE eight_effects SET status = 'done', result = ? WHERE key = ?")
			.run(result, key);
	}

	/** Calls cut off mid-effect and not rerun: what a person must look at. */
	unresolved(): EffectRow[] {
		return this.db
			.prepare("SELECT key, tool, status, result FROM eight_effects WHERE status = 'started'")
			.all() as unknown as EffectRow[];
	}

	close(): void {
		this.db.close();
	}
}
