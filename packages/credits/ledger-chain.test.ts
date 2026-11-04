import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { balance, closeLedger, ledgerPath, ledgerSnapshot, migrateLedger, rows, spend, topup, verifyChain } from "./ledger";

let dir: string;
const savedDb = process.env.EIGHT_CREDITS_DB;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "credits-chain-"));
	process.env.EIGHT_CREDITS_DB = join(dir, "credits.db");
});

afterAll(() => {
	closeLedger();
	if (savedDb === undefined) Reflect.deleteProperty(process.env, "EIGHT_CREDITS_DB");
	else process.env.EIGHT_CREDITS_DB = savedDb;
	rmSync(dir, { recursive: true, force: true });
});

describe("credit ledger integrity chain", () => {
	test("an untouched ledger verifies; a retried debit adds no link", () => {
		topup("t-chain", 100, { payment_ref: "pay-c" });
		spend("t-chain", 10, "c1");
		spend("t-chain", 10, "c1");
		expect(verifyChain("t-chain")).toEqual({ ok: true, checked: 2 });
	});

	test("an edited row is detected and named", () => {
		topup("t-tamper", 100, { payment_ref: "pay-t" });
		spend("t-tamper", 10, "t1");
		spend("t-tamper", 10, "t2");
		const id = rows("t-tamper")[1].id;
		const raw = new Database(ledgerPath());
		raw.run("UPDATE ledger SET tokens = 1 WHERE id = ?", [id]);
		raw.close();
		expect(verifyChain("t-tamper")).toMatchObject({ ok: false, brokenAt: id });
	});

	test("a removed middle row is detected", () => {
		topup("t-del", 100, { payment_ref: "pay-d" });
		spend("t-del", 10, "d1");
		spend("t-del", 10, "d2");
		const mid = rows("t-del")[1].id;
		const raw = new Database(ledgerPath());
		raw.run("DELETE FROM ledger WHERE id = ?", [mid]);
		raw.close();
		expect(verifyChain("t-del").ok).toBe(false);
	});
});

function raw(fn: (d: Database) => void): void {
	const d = new Database(ledgerPath());
	fn(d);
	d.close();
}

describe("8SO exploits on #28", () => {
	test("B1: a forged NULL-hash topup fails verify and the balance refuses", () => {
		topup("t-forge", 100, { payment_ref: "pay-f" });
		raw((d) => d.run("INSERT INTO ledger (ts,tenant,kind,tokens,payment_ref) VALUES ('2026-01-01','t-forge','topup',1000000,'x')"));
		expect(verifyChain("t-forge")).toMatchObject({ ok: false, reason: "unchained" });
		expect(() => balance("t-forge")).toThrow(/verification/);
		expect(() => ledgerSnapshot("t-forge")).toThrow(/verification/);
	});

	test("B2: nulling the hash of the newest row is detected", () => {
		topup("t-null", 100, { payment_ref: "pay-n" });
		spend("t-null", 40, "n1");
		raw((d) => d.run("UPDATE ledger SET hash = NULL, kind = 'topup' WHERE tenant = 't-null' AND job_id = 'n1'"));
		expect(verifyChain("t-null")).toMatchObject({ ok: false, reason: "unchained" });
		expect(() => balance("t-null")).toThrow();
	});

	test("B4: removing the newest row is detected as truncation", () => {
		topup("t-trunc", 100, { payment_ref: "pay-tr" });
		spend("t-trunc", 10, "tr1");
		expect(balance("t-trunc")).toBe(90);
		raw((d) => d.run("DELETE FROM ledger WHERE tenant = 't-trunc' AND job_id = 'tr1'"));
		expect(verifyChain("t-trunc")).toMatchObject({ ok: false, reason: "truncated" });
		expect(() => balance("t-trunc")).toThrow();
		expect(() => spend("t-trunc", 1, "tr2")).toThrow(/head/);
	});

	test("reorder is detected", () => {
		topup("t-re", 100, { payment_ref: "pay-r" });
		spend("t-re", 10, "r1");
		spend("t-re", 10, "r2");
		const [, a, b] = rows("t-re");
		raw((d) => {
			d.run("UPDATE ledger SET id = -1 WHERE id = ?", [a.id]);
			d.run("UPDATE ledger SET id = ? WHERE id = ?", [a.id, b.id]);
			d.run("UPDATE ledger SET id = ? WHERE id = -1", [b.id]);
		});
		expect(verifyChain("t-re").ok).toBe(false);
	});

	test("B3: a pre-chain ledger is refused on open, then migrated once with a meta entry", () => {
		closeLedger();
		const legacy = join(dir, "legacy.db");
		process.env.EIGHT_CREDITS_DB = legacy;
		const old = new Database(legacy, { create: true });
		old.run(`CREATE TABLE ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, tenant TEXT NOT NULL,
			kind TEXT NOT NULL, tokens INTEGER NOT NULL, job_id TEXT, payment_ref TEXT, note TEXT)`);
		old.run("INSERT INTO ledger (ts,tenant,kind,tokens,payment_ref) VALUES ('2026-01-01','t-old','topup',500,'p')");
		old.run("INSERT INTO ledger (ts,tenant,kind,tokens,job_id) VALUES ('2026-01-02','t-old','spend',20,'o1')");
		old.close();
		expect(() => balance("t-old")).toThrow(/unchained/);
		expect(migrateLedger()).toBe(2);
		expect(verifyChain("t-old")).toEqual({ ok: true, checked: 2 });
		expect(balance("t-old")).toBe(480);
		expect(migrateLedger()).toBe(0);
		raw((d) => expect((d.query("SELECT COUNT(*) AS n FROM ledger_meta WHERE event = 'migrate-chain'").get() as { n: number }).n).toBe(1));
		closeLedger();
		process.env.EIGHT_CREDITS_DB = join(dir, "credits.db");
	});
});
