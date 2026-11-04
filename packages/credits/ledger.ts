/**
 * Append-only token ledger (epic #3, first slice).
 *
 * Rows are topup or spend, in tokens only. Balance is derived (topups minus
 * spends), never stored. A spend carries a job_id that is UNIQUE, so a job
 * reported twice debits once. Every read takes a tenant and filters on it.
 * Local bun:sqlite file (mode 0600); nothing leaves the device. No prices, no
 * payment rail: a topup must carry a payment_ref, a spend never does.
 *
 * Integrity: each row stores hash = sha256(prev_hash + row fields), chained per
 * tenant. verifyChain() recomputes and reports the first row that was edited,
 * or whose predecessor was removed. Removing the newest row leaves a valid
 * chain (no external anchor yet), so that case is not detected.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const TENANT_ZERO = "8gi";

export interface LedgerRow {
	id: number;
	ts: string;
	tenant: string;
	kind: "topup" | "spend";
	tokens: number;
	job_id: string | null;
	payment_ref: string | null;
	note: string | null;
	prev_hash: string | null;
	hash: string | null;
}

export interface ChainResult {
	ok: boolean;
	checked: number;
	/** id of the first row that does not verify, when ok is false. */
	brokenAt?: number;
}

export interface LedgerSnapshot {
	tenant: string;
	balance: number;
	topped_up: number;
	spent: number;
	jobs_today: number;
	updated: string | null;
}

export function ledgerPath(): string {
	return process.env.EIGHT_CREDITS_DB || join(homedir(), ".8gent", "credits.db");
}

const open = new Map<string, Database>();

function db(): Database {
	const path = ledgerPath();
	let d = open.get(path);
	if (!d) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		d = new Database(path, { create: true });
		if (path !== ":memory:") chmodSync(path, 0o600);
		d.run(`CREATE TABLE IF NOT EXISTS ledger (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			ts TEXT NOT NULL,
			tenant TEXT NOT NULL,
			kind TEXT NOT NULL CHECK (kind IN ('topup','spend')),
			tokens INTEGER NOT NULL CHECK (tokens > 0),
			job_id TEXT,
			payment_ref TEXT,
			note TEXT,
			prev_hash TEXT,
			hash TEXT
		)`);
		const cols = (d.query("PRAGMA table_info(ledger)").all() as { name: string }[]).map((c) => c.name);
		if (!cols.includes("hash")) {
			d.run("ALTER TABLE ledger ADD COLUMN prev_hash TEXT");
			d.run("ALTER TABLE ledger ADD COLUMN hash TEXT");
		}
		d.run("CREATE UNIQUE INDEX IF NOT EXISTS ledger_spend_job ON ledger(job_id) WHERE kind = 'spend'");
		d.run("CREATE INDEX IF NOT EXISTS ledger_tenant ON ledger(tenant)");
		open.set(path, d);
	}
	return d;
}

/** Close cached handles (tests, shutdown). */
export function closeLedger(): void {
	for (const d of open.values()) d.close();
	open.clear();
}

function append(
	kind: "topup" | "spend",
	tenant: string,
	tokens: number,
	extra: { job_id?: string; payment_ref?: string | null; note?: string | null },
): boolean {
	if (!tenant) throw new Error("ledger: tenant required");
	if (!Number.isInteger(tokens) || tokens <= 0) throw new Error("ledger: tokens must be a positive integer");
	const d = db();
	const ts = new Date().toISOString();
	const job_id = extra.job_id ?? null;
	const payment_ref = extra.payment_ref ?? null;
	const note = extra.note ?? null;
	return d.transaction(() => {
		const last = d
			.query("SELECT hash FROM ledger WHERE tenant = ? AND hash IS NOT NULL ORDER BY id DESC LIMIT 1")
			.get(tenant) as { hash: string } | null;
		const prev = last?.hash ?? null;
		const hash = rowHash(prev, { ts, tenant, kind, tokens, job_id, payment_ref, note });
		const r = d.run(
			"INSERT OR IGNORE INTO ledger (ts, tenant, kind, tokens, job_id, payment_ref, note, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?)",
			[ts, tenant, kind, tokens, job_id, payment_ref, note, prev, hash],
		);
		return r.changes === 1;
	})();
}

function rowHash(
	prev: string | null,
	r: { ts: string; tenant: string; kind: string; tokens: number; job_id: string | null; payment_ref: string | null; note: string | null },
): string {
	return createHash("sha256")
		.update(JSON.stringify([prev, r.ts, r.tenant, r.kind, r.tokens, r.job_id, r.payment_ref, r.note]))
		.digest("hex");
}

/** Recompute the tenant's chain. Rows written before the chain existed (hash null) are skipped. */
export function verifyChain(tenant: string): ChainResult {
	const all = db().query("SELECT * FROM ledger WHERE tenant = ? AND hash IS NOT NULL ORDER BY id").all(tenant) as LedgerRow[];
	let prev: string | null = null;
	for (const r of all) {
		if (r.prev_hash !== prev || rowHash(prev, r) !== r.hash) return { ok: false, checked: all.length, brokenAt: r.id };
		prev = r.hash;
	}
	return { ok: true, checked: all.length };
}

export function topup(tenant: string, tokens: number, opts: { payment_ref: string; note?: string }): void {
	if (!opts?.payment_ref) throw new Error("ledger: a topup needs a payment_ref");
	append("topup", tenant, tokens, opts);
}

/** Debit a job once. Returns false when job_id was already recorded (no-op). */
export function spend(tenant: string, tokens: number, jobId: string, note?: string): boolean {
	if (!jobId) throw new Error("ledger: job_id required for a spend");
	return append("spend", tenant, tokens, { job_id: jobId, note });
}

function sum(tenant: string, kind: "topup" | "spend"): number {
	const row = db()
		.query("SELECT COALESCE(SUM(tokens),0) AS n FROM ledger WHERE tenant = ? AND kind = ?")
		.get(tenant, kind) as { n: number };
	return row.n;
}

export function balance(tenant: string): number {
	return sum(tenant, "topup") - sum(tenant, "spend");
}

export function rows(tenant: string): LedgerRow[] {
	return db().query("SELECT * FROM ledger WHERE tenant = ? ORDER BY id").all(tenant) as LedgerRow[];
}

/** Read for the world view: derived from rows, nothing cached. */
export function ledgerSnapshot(tenant: string = TENANT_ZERO): LedgerSnapshot {
	const topped_up = sum(tenant, "topup");
	const spent = sum(tenant, "spend");
	const today = new Date().toISOString().slice(0, 10);
	const jobs = db()
		.query("SELECT COUNT(*) AS n FROM ledger WHERE tenant = ? AND kind = 'spend' AND substr(ts,1,10) = ?")
		.get(tenant, today) as { n: number };
	const last = db().query("SELECT MAX(ts) AS ts FROM ledger WHERE tenant = ?").get(tenant) as { ts: string | null };
	return { tenant, balance: topped_up - spent, topped_up, spent, jobs_today: jobs.n, updated: last.ts };
}
