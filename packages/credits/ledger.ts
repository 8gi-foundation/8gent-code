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
 * tenant, and ledger_head(tenant, count, hash) is updated in the same
 * transaction as every append. verifyChain() walks every row of the tenant (the
 * same set balance() sums): a NULL hash, an edited, reordered or removed row, or
 * a count/tail that disagrees with the head, fails with a reason. balance() and
 * ledgerSnapshot() refuse (throw) when verify fails. A ledger with unchained
 * rows is refused on open until migrateLedger() chains it once and records a
 * ledger_meta entry. Limit: the head lives in the same file, so this stops
 * accidental and naive tampering, not someone who rewrites both tables; a
 * signed or out-of-file anchor is a follow-up.
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
	reason?: "unchained" | "broken" | "truncated" | "no-head";
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

function db(allowLegacy = false): Database {
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
		d.run("CREATE TABLE IF NOT EXISTS ledger_head (tenant TEXT PRIMARY KEY, count INTEGER NOT NULL, hash TEXT NOT NULL)");
		d.run("CREATE TABLE IF NOT EXISTS ledger_meta (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, event TEXT NOT NULL, detail TEXT)");
		d.run("CREATE TRIGGER IF NOT EXISTS ledger_meta_no_update BEFORE UPDATE ON ledger_meta BEGIN SELECT RAISE(ABORT, 'ledger_meta is append-only'); END");
		d.run("CREATE TRIGGER IF NOT EXISTS ledger_meta_no_delete BEFORE DELETE ON ledger_meta BEGIN SELECT RAISE(ABORT, 'ledger_meta is append-only'); END");
		const legacy = d.query("SELECT COUNT(*) AS n FROM ledger WHERE hash IS NULL").get() as { n: number };
		if (legacy.n > 0 && !allowLegacy) {
			d.close();
			throw new Error(`ledger: ${legacy.n} unchained row(s) in ${path}; refusing to open. Run migrateLedger() once to chain them.`);
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
	return d
		.transaction(() => {
			const head = d.query("SELECT count, hash FROM ledger_head WHERE tenant = ?").get(tenant) as { count: number; hash: string } | null;
			const last = d.query("SELECT hash FROM ledger WHERE tenant = ? ORDER BY id DESC LIMIT 1").get(tenant) as { hash: string | null } | null;
			if ((head?.hash ?? null) !== (last?.hash ?? null)) throw new Error(`ledger: head does not match the last row for ${tenant}; refusing to append`);
			const prev = head?.hash ?? null;
			const hash = rowHash(prev, { ts, tenant, kind, tokens, job_id, payment_ref, note });
			const r = d.run(
				"INSERT OR IGNORE INTO ledger (ts, tenant, kind, tokens, job_id, payment_ref, note, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?)",
				[ts, tenant, kind, tokens, job_id, payment_ref, note, prev, hash],
			);
			if (r.changes !== 1) return false;
			d.run(
				"INSERT INTO ledger_head (tenant, count, hash) VALUES (?,1,?) ON CONFLICT(tenant) DO UPDATE SET count = count + 1, hash = excluded.hash",
				[tenant, hash],
			);
			return true;
		})
		.immediate();
}

function rowHash(
	prev: string | null,
	r: { ts: string; tenant: string; kind: string; tokens: number; job_id: string | null; payment_ref: string | null; note: string | null },
): string {
	return createHash("sha256")
		.update(JSON.stringify([prev, r.ts, r.tenant, r.kind, r.tokens, r.job_id, r.payment_ref, r.note]))
		.digest("hex");
}

/** Recompute the tenant's chain over every row and check it against the head. */
export function verifyChain(tenant: string): ChainResult {
	const d = db();
	const all = d.query("SELECT * FROM ledger WHERE tenant = ? ORDER BY id").all(tenant) as LedgerRow[];
	let prev: string | null = null;
	for (const r of all) {
		if (r.hash === null) return { ok: false, checked: all.length, brokenAt: r.id, reason: "unchained" };
		if (r.prev_hash !== prev || rowHash(prev, r) !== r.hash) return { ok: false, checked: all.length, brokenAt: r.id, reason: "broken" };
		prev = r.hash;
	}
	const head = d.query("SELECT count, hash FROM ledger_head WHERE tenant = ?").get(tenant) as { count: number; hash: string } | null;
	if (!head) return all.length === 0 ? { ok: true, checked: 0 } : { ok: false, checked: all.length, reason: "no-head" };
	if (head.count !== all.length || head.hash !== prev) return { ok: false, checked: all.length, reason: "truncated" };
	return { ok: true, checked: all.length };
}

function assertVerified(tenant: string): void {
	const v = verifyChain(tenant);
	if (!v.ok) throw new Error(`ledger: chain for ${tenant} failed verification (${v.reason}${v.brokenAt ? ` at row ${v.brokenAt}` : ""}); refusing to compute a balance`);
}

/**
 * One-time, explicit migration of a genuinely pre-chain ledger. It refuses, loudly,
 * unless every row is unchained and no head or earlier migration entry exists: a
 * ledger that has ever been chained, or has a checkpoint, is never re-chained, so
 * migration cannot launder a forged or truncated chain. On success it chains every
 * row, writes the heads and an append-only "migrated at N rows, hash H" meta entry
 * (update and delete are blocked by trigger). Only an operator command calls this
 * (see migrate-cli.ts); nothing runs it automatically.
 * Returns the number of rows chained (0 = empty ledger, nothing to do).
 */
export function migrateLedger(): number {
	const d = db(true);
	return d
		.transaction(() => {
			const total = (d.query("SELECT COUNT(*) AS n FROM ledger").get() as { n: number }).n;
			const chained = (d.query("SELECT COUNT(*) AS n FROM ledger WHERE hash IS NOT NULL OR prev_hash IS NOT NULL").get() as { n: number }).n;
			const heads = (d.query("SELECT COUNT(*) AS n FROM ledger_head").get() as { n: number }).n;
			const done = (d.query("SELECT COUNT(*) AS n FROM ledger_meta WHERE event = 'migrate-chain'").get() as { n: number }).n;
			if (chained > 0 || heads > 0 || done > 0) {
				throw new Error(`ledger: refusing to migrate; it has chain data (${chained} chained rows, ${heads} heads, ${done} prior migrations). A chained ledger is never re-chained.`);
			}
			if (total === 0) return 0;
			const tails: string[] = [];
			const tenants = d.query("SELECT DISTINCT tenant FROM ledger ORDER BY tenant").all() as { tenant: string }[];
			for (const { tenant } of tenants) {
				let prev: string | null = null;
				let count = 0;
				for (const r of d.query("SELECT * FROM ledger WHERE tenant = ? ORDER BY id").all(tenant) as LedgerRow[]) {
					const hash = rowHash(prev, r);
					d.run("UPDATE ledger SET prev_hash = ?, hash = ? WHERE id = ?", [prev, hash, r.id]);
					prev = hash;
					count++;
				}
				d.run("INSERT INTO ledger_head (tenant, count, hash) VALUES (?,?,?)", [tenant, count, prev]);
				tails.push(`${tenant}:${prev}`);
			}
			const H = createHash("sha256").update(tails.join("\n")).digest("hex");
			d.run("INSERT INTO ledger_meta (ts, event, detail) VALUES (?,?,?)", [new Date().toISOString(), "migrate-chain", `migrated at ${total} rows, hash ${H}`]);
			return total;
		})
		.immediate();
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
	assertVerified(tenant);
	return sum(tenant, "topup") - sum(tenant, "spend");
}

export function rows(tenant: string): LedgerRow[] {
	return db().query("SELECT * FROM ledger WHERE tenant = ? ORDER BY id").all(tenant) as LedgerRow[];
}

/** Read for the world view: derived from rows, nothing cached. */
export function ledgerSnapshot(tenant: string = TENANT_ZERO): LedgerSnapshot {
	assertVerified(tenant);
	const topped_up = sum(tenant, "topup");
	const spent = sum(tenant, "spend");
	const today = new Date().toISOString().slice(0, 10);
	const jobs = db()
		.query("SELECT COUNT(*) AS n FROM ledger WHERE tenant = ? AND kind = 'spend' AND substr(ts,1,10) = ?")
		.get(tenant, today) as { n: number };
	const last = db().query("SELECT MAX(ts) AS ts FROM ledger WHERE tenant = ?").get(tenant) as { ts: string | null };
	return { tenant, balance: topped_up - spent, topped_up, spent, jobs_today: jobs.n, updated: last.ts };
}
