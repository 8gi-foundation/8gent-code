/**
 * Hash chain tests (8gi-governance#1108, gap 2): the core module, the two
 * append-only SQLite stores, and the dependency-free JSONL ledger script.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityAuditStore } from "./capability-store.js";
import {
	type ChainEntry,
	GENESIS_HASH,
	canonicalJson,
	chainHash,
	verifyChain,
} from "./hash-chain.js";
import * as ledger from "./ledger-chain.mjs";
import { AccessAuditStore } from "./store.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "audit-chain-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function buildChain(records: Array<Record<string, unknown>>): ChainEntry[] {
	let prev = GENESIS_HASH;
	return records.map((record) => {
		const hash = chainHash(prev, record);
		const entry = { record, prevHash: prev, hash };
		prev = hash;
		return entry;
	});
}

const access = (i: number) => ({
	actor: `human:parent_${i}`,
	actorKind: "human" as const,
	targetTable: "child_profile",
	targetId: `child_${i}`,
	operation: "read" as const,
	reason: `view ${i}`,
});

describe("canonicalJson", () => {
	it("sorts keys at every depth and drops whitespace", () => {
		expect(canonicalJson({ b: 1, a: { d: [1, { z: 0, y: null }], c: "x" } })).toBe(
			'{"a":{"c":"x","d":[1,{"y":null,"z":0}]},"b":1}',
		);
	});

	it("rejects values JSON cannot carry", () => {
		expect(() => canonicalJson({ n: Number.NaN })).toThrow();
	});

	it("genesis is 64 zeros and hash is sha256(prev + canonical)", () => {
		expect(GENESIS_HASH).toBe("0".repeat(64));
		const expected = new Bun.CryptoHasher("sha256").update(`${GENESIS_HASH}{"a":1}`).digest("hex");
		expect(chainHash(GENESIS_HASH, { a: 1 })).toBe(expected);
	});
});

describe("verifyChain", () => {
	const records = [1, 2, 3, 4, 5].map((n) => ({ n, msg: `record ${n}` }));

	it("an intact chain verifies and returns its head", () => {
		const chain = buildChain(records);
		expect(verifyChain(chain)).toEqual({
			ok: true,
			total: 5,
			preChain: 0,
			headHash: chain[4].hash as string,
		});
	});

	it("an edited record is caught at its index", () => {
		const chain = buildChain(records);
		(chain[2].record as { msg: string }).msg = "record 3!";
		const r = verifyChain(chain);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.index).toBe(2);
	});

	it("a deleted record is caught where the gap is", () => {
		const chain = buildChain(records);
		chain.splice(1, 1);
		const r = verifyChain(chain);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.index).toBe(1);
	});

	it("deleting the first chained record is caught", () => {
		const r = verifyChain(buildChain(records).slice(1));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.index).toBe(0);
	});

	it("reordered records are caught", () => {
		const chain = buildChain(records);
		[chain[2], chain[3]] = [chain[3], chain[2]];
		const r = verifyChain(chain);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.index).toBe(2);
	});

	it("pre-chain records at the start are tolerated, not tampered", () => {
		const pre = [{ record: { old: 1 }, prevHash: null, hash: null }];
		const r = verifyChain([...pre, ...pre, ...buildChain(records)]);
		expect(r).toMatchObject({ ok: true, total: 7, preChain: 2 });
	});

	it("a record with hashes stripped after the chain started is broken", () => {
		const chain = buildChain(records);
		chain[3] = { record: chain[3].record, prevHash: null, hash: null };
		const r = verifyChain(chain);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.index).toBe(3);
	});
});

describe("AccessAuditStore chain", () => {
	it("chains every append and verifies", () => {
		const store = new AccessAuditStore(join(dir, "a.db"));
		for (let i = 0; i < 4; i++) store.logAccess(access(i));
		expect(store.verifyChain()).toMatchObject({ ok: true, total: 4, preChain: 0 });
		store.close();
	});

	it("an edited row is caught at its index", () => {
		const path = join(dir, "a.db");
		const store = new AccessAuditStore(path);
		for (let i = 0; i < 5; i++) store.logAccess(access(i));
		store.close();

		const raw = new Database(path);
		raw.exec("UPDATE access_audit_log SET reason = 'nothing to see' WHERE target_id = 'child_2'");
		raw.close();

		const reopened = new AccessAuditStore(path);
		const r = reopened.verifyChain();
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.index).toBe(2);
		reopened.close();
	});

	it("a deleted row is caught", () => {
		const path = join(dir, "a.db");
		const store = new AccessAuditStore(path);
		for (let i = 0; i < 5; i++) store.logAccess(access(i));
		store.close();

		const raw = new Database(path);
		raw.exec("DELETE FROM access_audit_log WHERE target_id = 'child_1'");
		raw.close();

		const reopened = new AccessAuditStore(path);
		const r = reopened.verifyChain();
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.index).toBe(1);
		reopened.close();
	});

	it("migrates a pre-chain table by adding columns only, and old rows read as pre-chain", () => {
		const path = join(dir, "old.db");
		const old = new Database(path);
		old.exec(`CREATE TABLE access_audit_log (
      id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, actor TEXT NOT NULL,
      actor_kind TEXT NOT NULL, target_table TEXT NOT NULL, target_id TEXT NOT NULL,
      operation TEXT NOT NULL, reason TEXT NOT NULL, session_id TEXT)`);
		old.exec(`INSERT INTO access_audit_log VALUES
      ('aud_old1', 1, 'human:p', 'human', 'child_profile', 'c1', 'read', 'old', NULL),
      ('aud_old2', 2, 'human:p', 'human', 'child_profile', 'c2', 'read', 'old', NULL)`);
		old.close();

		const store = new AccessAuditStore(path);
		store.logAccess(access(9));
		store.logAccess(access(10));
		expect(store.verifyChain()).toMatchObject({ ok: true, total: 4, preChain: 2 });
		expect(store.count()).toBe(4);
		expect(store.queryAccess({ targetId: "c1" })[0].reason).toBe("old");
		store.close();
	});
});

describe("CapabilityAuditStore chain", () => {
	it("chains appends and catches an edit", () => {
		const path = join(dir, "c.db");
		const store = new CapabilityAuditStore(path);
		for (const op of ["grant", "revoke", "grant"] as const) {
			store.logCapability({
				actor: "human:james",
				actorKind: "human",
				skill: "deploy",
				capability: "network",
				operation: op,
				reason: "test",
			});
		}
		expect(store.verifyChain()).toMatchObject({ ok: true, total: 3 });
		store.close();

		const raw = new Database(path);
		raw.exec("UPDATE capability_audit_log SET operation = 'grant' WHERE operation = 'revoke'");
		raw.close();

		const reopened = new CapabilityAuditStore(path);
		const r = reopened.verifyChain();
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.index).toBe(1);
		reopened.close();
	});
});

describe("ledger-chain.mjs (JSONL)", () => {
	function writeLedger(n: number): string {
		const file = join(dir, "merges.jsonl");
		for (let i = 1; i <= n; i++) {
			ledger.appendChained(file, {
				repo: "8gent-code",
				pr: 5000 + i,
				sha: `abc${i}`,
				verdict: "merged",
			});
		}
		return file;
	}

	it("gives the same hashes as hash-chain.ts", () => {
		const record = { z: [1, "two", { b: null, a: true }], a: "é ✓", n: 1.5 };
		expect(ledger.GENESIS_HASH).toBe(GENESIS_HASH);
		expect(ledger.canonicalJson(record)).toBe(canonicalJson(record));
		expect(ledger.chainHash(GENESIS_HASH, record)).toBe(chainHash(GENESIS_HASH, record));
	});

	it("append then verify is ok, with the head of the last line", () => {
		const file = writeLedger(4);
		const lines = readFileSync(file, "utf8").trim().split("\n");
		expect(lines.length).toBe(4);
		const last = JSON.parse(lines[3]);
		expect(JSON.parse(lines[0]).prev_hash).toBe(GENESIS_HASH);
		expect(ledger.verifyLedger(readFileSync(file, "utf8"))).toEqual({
			ok: true,
			total: 4,
			preChain: 0,
			headHash: last.hash,
		});
	});

	it("one byte changed mid-chain is caught at that line", () => {
		const file = writeLedger(5);
		const text = readFileSync(file, "utf8");
		const at = text.indexOf("abc3");
		const tampered = `${text.slice(0, at)}abd3${text.slice(at + 4)}`;
		expect(tampered.length).toBe(text.length);
		expect(ledger.verifyLedger(tampered)).toMatchObject({ ok: false, index: 2, line: 3 });
	});

	it("a deleted line is caught", () => {
		const lines = readFileSync(writeLedger(5), "utf8").trim().split("\n");
		lines.splice(2, 1);
		expect(ledger.verifyLedger(lines.join("\n"))).toMatchObject({ ok: false, index: 2 });
	});

	it("reordered lines are caught", () => {
		const lines = readFileSync(writeLedger(5), "utf8").trim().split("\n");
		[lines[1], lines[2]] = [lines[2], lines[1]];
		expect(ledger.verifyLedger(lines.join("\n"))).toMatchObject({ ok: false, index: 1 });
	});

	it("pre-chain lines at the top are tolerated and the writer chains after them", () => {
		const file = join(dir, "old.jsonl");
		writeFileSync(file, '{"pr":1,"verdict":"merged"}\n{"pr":2,"verdict":"merged"}\n');
		ledger.appendChained(file, { pr: 3, verdict: "merged" });
		ledger.appendChained(file, { pr: 4, verdict: "merged" });
		expect(ledger.verifyLedger(readFileSync(file, "utf8"))).toMatchObject({
			ok: true,
			total: 4,
			preChain: 2,
		});
	});

	it("refuses records that already carry chain fields", () => {
		expect(() => ledger.sealLine(GENESIS_HASH, { hash: "x" })).toThrow();
		expect(() => ledger.sealLine(GENESIS_HASH, [1, 2])).toThrow();
	});

	it("runs as a standalone script with node-style exit codes", () => {
		const file = writeLedger(3);
		const script = join(import.meta.dir, "ledger-chain.mjs");
		const ok = Bun.spawnSync(["bun", script, "verify", file]);
		expect(ok.exitCode).toBe(0);
		expect(ok.stdout.toString()).toContain("ok: 3 lines");

		const appended = Bun.spawnSync(["bun", script, "append", file, '{"pr":9}']);
		expect(appended.exitCode).toBe(0);

		writeFileSync(file, readFileSync(file, "utf8").replace('"pr":5002', '"pr":5003'));
		const bad = Bun.spawnSync(["bun", script, "verify", file]);
		expect(bad.exitCode).toBe(2);
		expect(bad.stderr.toString()).toContain("broken at line 2");
	});
});
