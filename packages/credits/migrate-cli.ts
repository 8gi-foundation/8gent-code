/**
 * Operator command: chain a pre-chain credits ledger, once.
 *   bun packages/credits/migrate-cli.ts
 * Prompt defaults to No. A non-interactive run (no TTY) refuses: unattended means no.
 */
import { createInterface } from "node:readline/promises";
import { ledgerPath, migrateLedger } from "./ledger";

if (!process.stdin.isTTY) {
	console.error("migrate-cli: not an interactive terminal; refusing.");
	process.exit(1);
}
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = (await rl.question(`Chain every row of ${ledgerPath()} now? This runs once and cannot be undone. [y/N] `)).trim().toLowerCase();
rl.close();
if (answer !== "y" && answer !== "yes") {
	console.log("No changes made.");
	process.exit(0);
}
try {
	console.log(`Chained ${migrateLedger()} rows.`);
} catch (e) {
	console.error((e as Error).message);
	process.exit(1);
}
