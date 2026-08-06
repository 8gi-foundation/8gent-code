// Repair the Table ledger after a concurrent-writer duplicate-seq. Renumbers
// entries contiguously in file order and re-chains prev_hash/hash. The signature
// (HMAC over canonical(payload)) depends only on the payload, which is untouched,
// so every sig stays valid and no key is needed. Backs up first; verifies after.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonical } from "../packages/goal/ledger";

const L = path.join(os.homedir(), ".8gent", "table", "ledger", "ledger.jsonl");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const lines = fs.readFileSync(L, "utf8").trim().split("\n").filter(Boolean);
const entries = lines.map((l) => JSON.parse(l));
const ZERO = entries[0].prev_hash; // the genuine zero-hash, read from entry 1

let prev = ZERO;
const fixed = entries.map((e: any, i: number) => {
	const canon = canonical(e.payload ?? {});
	const hash = sha(prev + canon);
	const out = { seq: i + 1, prev_hash: prev, hash, ts: e.ts, kind: e.kind, payload: e.payload, sig: e.sig };
	prev = hash;
	return out;
});

const backup = `${L}.bak-${entries.length}-${entries[0].ts}`;
fs.copyFileSync(L, backup);
fs.writeFileSync(L, fixed.map((e) => JSON.stringify(e)).join("\n") + "\n");

const seqs = fixed.map((e) => e.seq);
const contiguous = seqs.every((s, i) => s === i + 1);
console.log(JSON.stringify({ repaired: fixed.length, contiguous, backup: path.basename(backup) }, null, 2));
