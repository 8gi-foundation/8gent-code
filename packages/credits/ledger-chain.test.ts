import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, ledgerPath, rows, spend, topup, verifyChain } from "./ledger";

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
