/**
 * Demonstration: an officer reply with one honest reference, one correct
 * assertion, one deliberately WRONG assertion, and a derivation - verified
 * end to end against the REAL repo, with every check recorded in a real
 * hash-chained ledger (a temp one: the live Table ledger has exactly one
 * writer, the daemon, and this demo is not it).
 *
 *   bun packages/verify/demo.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Ledger } from "../goal/ledger";
import { processClaims } from "./pipeline";

const repo = path.resolve(import.meta.dir, "..", "..");
const ledgerFile = path.join(repo, "packages", "goal", "ledger.ts");

// What Karen (8SO) would emit in a Table turn. She wrote ZERO numbers for the
// verified facts - only references. The 9999 is the deliberate lie.
const officerReply = [
	"Security review of the ledger chain, evidence attached.",
	`Repo HEAD: [[CLAIM id=c1 src=git.head repo=${repo}]]`,
	`Branch: [[CLAIM src=git.branch repo=${repo}]]`,
	`ledger.ts is [[CLAIM id=c2 src=file.lines path=${ledgerFile}]] lines,`,
	`and I assert the goal package has [[CLAIM id=c3 src=dir.count path=${path.join(repo, "packages", "goal")} glob=*.test.ts expect=6]] test files.`,
	`The chain doc line reads: [[CLAIM src=file.line path=${ledgerFile} line=2]]`,
	"",
	"DELIBERATELY WRONG (should be caught and stripped):",
	`ledger.ts is [[CLAIM src=file.lines path=${ledgerFile} expect=9999]] lines.`,
	"",
	"Derived: test files per hundred ledger lines is meaningless, so instead -",
	"total of the two counts: [[DERIVE op=sum of=c2,c3]]",
].join("\n");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "verify-demo-"));
const ledger = Ledger.open({ runId: "demo", baseDir: tmp, key: Buffer.from("demo-key".repeat(4)) });

console.log("== OFFICER REPLY (as emitted - references, not values) ==\n");
console.log(officerReply);

const out = processClaims(officerReply, { ledger });

console.log("\n== CHANNEL MESSAGE (as posted - values verified, lies stripped) ==\n");
console.log(out.text);

console.log("\n== CLAIM RESULTS ==\n");
for (const r of out.results) {
	console.log(
		`${r.status.toUpperCase().padEnd(9)} ${r.id.padEnd(4)} ${r.src}${r.value !== undefined ? ` -> ${r.value}` : ""}${r.reason ? `  (${r.reason})` : ""}`,
	);
}

const verify = ledger.verify();
console.log(
	`\n== LEDGER == ${ledger.currentSeq} entries, chain verify: ${verify.ok ? "OK" : verify.reason}`,
);
console.log(`head hash: ${ledger.headHash}`);
console.log(`allVerified: ${out.allVerified} (false is CORRECT - the lie was caught)`);

ledger.close();
fs.rmSync(tmp, { recursive: true, force: true });
