#!/usr/bin/env bun
/**
 * Local test driver for officer agents.
 *
 * Usage: bun scripts/run-officer.ts <CODE> "<task>"
 * Example:
 *   bun scripts/run-officer.ts 8TO "Triage 8gent-code issue 1909 - find the actual gap, post a 5-line analysis with file:line citations"
 *
 * Runs the configured officer prompt + agent loop locally so you can verify
 * the output is real engineering evidence (not LinkedIn fluff) before
 * deploying the same wiring to the Fly vessel.
 */

import { runOfficerAgent } from "../packages/board-vessel/agent-runner";

const args = process.argv.slice(2);
if (args.length < 2) {
	console.error("Usage: bun scripts/run-officer.ts <CODE> <task>");
	console.error("       bun scripts/run-officer.ts 8TO \"Triage issue 1909\"");
	process.exit(1);
}

const code = args[0];
const task = args.slice(1).join(" ");

console.log(`\n[run-officer] code=${code}`);
console.log(`[run-officer] task=${task}\n`);

const start = performance.now();

try {
	const out = await runOfficerAgent({ code, task });
	const ms = Math.round(performance.now() - start);

	console.log(`\n${"=".repeat(70)}`);
	console.log(`OFFICER ${out.officer} REPORT`);
	console.log("=".repeat(70));
	console.log(out.text);
	console.log("=".repeat(70));
	console.log(`steps=${out.steps} tokens=${out.totalTokens} elapsed=${ms}ms`);
} catch (err) {
	console.error("\n[run-officer] failed:", err instanceof Error ? err.message : err);
	process.exit(1);
}
