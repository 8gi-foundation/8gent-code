/**
 * M0 real-query check for search_symbols (scope: jev-ast-locator, 2026-09-28).
 *
 * Runs the 10 symbol queries from the scope doc through the real
 * ToolExecutor search_symbols tool against this repo and checks that the
 * top-1 hit is the true definition file. Prints per-query latency and the
 * one-off index build time. Exits 1 on anything below 10/10.
 *
 *   bun packages/ast-index/eval/real-queries.ts [repoRoot]
 */

import * as path from "node:path";
import { ToolExecutor } from "../../eight/tools";
import { ensureIndexed } from "../index";

/** query -> true definition file, relative to the repo root. */
const CASES: Array<[query: string, file: string]> = [
	["createDecider", "packages/decide/index.ts"],
	["systemOneGate", "packages/permissions/system-one-gate.ts"],
	["indexFolder", "packages/ast-index/index.ts"],
	["RepoMapper", "packages/repo-context/mapper.ts"],
	["safePath", "packages/eight/tools.ts"],
	["decideRules", "packages/decide/rules.ts"],
	["parseTypeScriptFile", "packages/ast-index/typescript-parser.ts"],
	["getRepoContext", "packages/eight/prompts/system-prompt.ts"],
	["ToolExecutor", "packages/eight/tools.ts"],
	["startSystemOneWarmup", "packages/permissions/system-one-gate.ts"],
];

type Match = { name: string; kind: string; file: string; line: number };

async function main(): Promise<void> {
	const root = path.resolve(process.argv[2] ?? path.join(import.meta.dir, "..", "..", ".."));

	const t0 = performance.now();
	const executor = new ToolExecutor(root);
	const index = await ensureIndexed(root);
	const buildMs = performance.now() - t0;
	console.log(
		`index: ${index.fileCount} files, ${index.symbolCount} symbols, build ${buildMs.toFixed(0)} ms (one build, shared)`,
	);

	let hits = 0;
	const times: number[] = [];
	for (const [query, expected] of CASES) {
		const t = performance.now();
		const out = await executor.execute("search_symbols", { query });
		const ms = performance.now() - t;
		times.push(ms);
		const top = (JSON.parse(out) as { matches: Match[] }).matches[0];
		const ok = top?.file === expected && top.name === query;
		if (ok) hits++;
		const got = top ? `${top.file}:${top.line} ${top.kind}` : "(no match)";
		console.log(
			`${ok ? "PASS" : "FAIL"}  ${query.padEnd(22)} ${ms.toFixed(1).padStart(6)} ms  ${got}`,
		);
	}

	const sorted = [...times].sort((a, b) => a - b);
	const p50 = sorted[Math.floor((sorted.length - 1) / 2)];
	console.log(
		`top-1: ${hits}/${CASES.length}  latency min ${sorted[0].toFixed(1)} / p50 ${p50.toFixed(1)} / max ${sorted[sorted.length - 1].toFixed(1)} ms`,
	);
	process.exit(hits === CASES.length ? 0 : 1);
}

main();
