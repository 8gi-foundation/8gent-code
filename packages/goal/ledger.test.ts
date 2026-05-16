/**
 * Ledger tests.
 *
 * Append-only hash-chained JSONL with HMAC signatures.
 * - Each entry references the previous entry's hash (Merkle-style chain).
 * - Each entry has an HMAC signature over its canonical payload.
 * - Verification walks the chain end-to-end. Tampering breaks the chain.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Ledger, ZERO_HASH } from "./ledger";

let tmpDir: string;
// Test key, 32 bytes hex. Production loads from ~/.8gent/keys/state-hmac.key.
const TEST_KEY = Buffer.from(
	"a".repeat(64),
	"hex",
);

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-ledger-"));
});

afterEach(() => {
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// best effort
	}
});

describe("Ledger.open", () => {
	it("creates the ledger directory if missing", () => {
		const runDir = path.join(tmpDir, "r-new");
		const l = Ledger.open({ runId: "r-new", baseDir: tmpDir, key: TEST_KEY });
		expect(fs.existsSync(runDir)).toBe(true);
		expect(fs.existsSync(path.join(runDir, "ledger.jsonl"))).toBe(true);
		l.close();
	});

	it("refuses to open if the directory is unwritable", () => {
		// Create a read-only parent dir.
		const ro = path.join(tmpDir, "ro");
		fs.mkdirSync(ro);
		fs.chmodSync(ro, 0o500); // r-x only
		try {
			expect(() =>
				Ledger.open({ runId: "rx", baseDir: ro, key: TEST_KEY }),
			).toThrow(/unwritable|EACCES|permission/i);
		} finally {
			fs.chmodSync(ro, 0o700);
		}
	});
});

describe("Ledger.append + verify", () => {
	it("first entry uses zero prev_hash", () => {
		const l = Ledger.open({ runId: "r1", baseDir: tmpDir, key: TEST_KEY });
		const e = l.append({ kind: "run.started", payload: { goal: "ship it" } });
		expect(e.seq).toBe(1);
		expect(e.prev_hash).toBe(ZERO_HASH);
		expect(e.hash).not.toBe(ZERO_HASH);
		expect(e.sig).toBeTruthy();
		const v = l.verify();
		expect(v.ok).toBe(true);
		l.close();
	});

	it("chains hashes: prev_hash of entry N = hash of entry N-1", () => {
		const l = Ledger.open({ runId: "r2", baseDir: tmpDir, key: TEST_KEY });
		const e1 = l.append({ kind: "run.started", payload: { goal: "x" } });
		const e2 = l.append({ kind: "turn.requested", payload: { turn: 1 } });
		const e3 = l.append({ kind: "turn.completed", payload: { turn: 1 } });
		expect(e2.prev_hash).toBe(e1.hash);
		expect(e3.prev_hash).toBe(e2.hash);
		expect(l.verify().ok).toBe(true);
		l.close();
	});

	it("assigns monotonic seq across appends", () => {
		const l = Ledger.open({ runId: "r3", baseDir: tmpDir, key: TEST_KEY });
		for (let i = 0; i < 10; i++) {
			const e = l.append({ kind: "turn.requested", payload: { turn: i + 1 } });
			expect(e.seq).toBe(i + 1);
		}
		expect(l.verify().ok).toBe(true);
		l.close();
	});

	it("verify fails when a payload is tampered with", () => {
		const l = Ledger.open({ runId: "r-tamper", baseDir: tmpDir, key: TEST_KEY });
		l.append({ kind: "run.started", payload: { goal: "good" } });
		l.append({ kind: "turn.requested", payload: { turn: 1 } });
		l.append({ kind: "turn.completed", payload: { turn: 1 } });
		l.close();

		// Mutate one entry's payload on disk - sig mismatch should fire.
		const file = path.join(tmpDir, "r-tamper", "ledger.jsonl");
		const lines = fs.readFileSync(file, "utf8").trim().split("\n");
		const second = JSON.parse(lines[1]);
		second.payload.turn = 999;
		lines[1] = JSON.stringify(second);
		fs.writeFileSync(file, `${lines.join("\n")}\n`);

		const l2 = Ledger.open({ runId: "r-tamper", baseDir: tmpDir, key: TEST_KEY });
		const v = l2.verify();
		expect(v.ok).toBe(false);
		expect(v.reason).toMatch(/sig|hash|tamper/i);
		expect(v.atSeq).toBe(2);
		l2.close();
	});

	it("verify fails when the hash chain is broken", () => {
		const l = Ledger.open({ runId: "r-chain", baseDir: tmpDir, key: TEST_KEY });
		l.append({ kind: "run.started", payload: { goal: "g" } });
		l.append({ kind: "turn.requested", payload: { turn: 1 } });
		l.append({ kind: "turn.completed", payload: { turn: 1 } });
		l.close();

		// Mutate the prev_hash of entry 2 (without re-signing).
		const file = path.join(tmpDir, "r-chain", "ledger.jsonl");
		const lines = fs.readFileSync(file, "utf8").trim().split("\n");
		const second = JSON.parse(lines[1]);
		second.prev_hash = ZERO_HASH;
		lines[1] = JSON.stringify(second);
		fs.writeFileSync(file, `${lines.join("\n")}\n`);

		const l2 = Ledger.open({ runId: "r-chain", baseDir: tmpDir, key: TEST_KEY });
		const v = l2.verify();
		expect(v.ok).toBe(false);
		expect(v.atSeq).toBe(2);
		l2.close();
	});

	it("verify fails on wrong key (sig mismatch)", () => {
		const l = Ledger.open({ runId: "r-key", baseDir: tmpDir, key: TEST_KEY });
		l.append({ kind: "run.started", payload: { goal: "g" } });
		l.append({ kind: "turn.requested", payload: { turn: 1 } });
		l.close();

		const wrongKey = Buffer.from("b".repeat(64), "hex");
		const l2 = Ledger.open({ runId: "r-key", baseDir: tmpDir, key: wrongKey });
		const v = l2.verify();
		expect(v.ok).toBe(false);
		expect(v.reason).toMatch(/sig/i);
		l2.close();
	});
});

describe("Ledger reopen + resume", () => {
	it("reopens the file and continues seq from last entry", () => {
		const l1 = Ledger.open({ runId: "r-resume", baseDir: tmpDir, key: TEST_KEY });
		l1.append({ kind: "run.started", payload: { goal: "g" } });
		l1.append({ kind: "turn.requested", payload: { turn: 1 } });
		l1.close();

		const l2 = Ledger.open({ runId: "r-resume", baseDir: tmpDir, key: TEST_KEY });
		const e3 = l2.append({ kind: "turn.completed", payload: { turn: 1 } });
		expect(e3.seq).toBe(3);
		expect(l2.verify().ok).toBe(true);
		l2.close();
	});
});
