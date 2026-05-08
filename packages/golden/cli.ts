#!/usr/bin/env bun
/**
 * Golden test CLI.
 *
 * Usage:
 *   bun run packages/golden/cli.ts                           # run full suite via daemon AgentPool
 *   bun run packages/golden/cli.ts --filter '^code-'         # run a subset
 *   bun run packages/golden/cli.ts --cases ./other/cases     # use a different case dir
 *   bun run packages/golden/cli.ts --dry-run                 # parse + grade-stub-output, do NOT call the agent
 *   bun run packages/golden/cli.ts --diff <runId>            # compare current run to a past run
 *   bun run packages/golden/cli.ts --no-store                # don't persist results
 *
 * Exits with code 0 on full pass, 1 if any case failed, 2 on a transport
 * error before the suite started.
 */

import * as path from "node:path";
import {
	type AgentRunResult,
	type CaseResult,
	type ChatTransport,
	agentPoolTransport,
	diffRuns,
	loadCasesFromDirectory,
	loadRun,
	runGolden,
	writeRun,
} from "./index";

interface CliArgs {
	filter?: string;
	casesDir: string;
	store: boolean;
	dryRun: boolean;
	diffAgainst?: string;
	help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = {
		casesDir: path.join(import.meta.dir, "cases"),
		store: true,
		dryRun: false,
		help: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--help" || a === "-h") args.help = true;
		else if (a === "--filter") args.filter = argv[++i];
		else if (a === "--cases") args.casesDir = path.resolve(argv[++i] ?? args.casesDir);
		else if (a === "--no-store") args.store = false;
		else if (a === "--dry-run") args.dryRun = true;
		else if (a === "--diff") args.diffAgainst = argv[++i];
	}
	return args;
}

function printHelp(): void {
	console.log(`8gent golden test runner

Usage:
  bun run packages/golden/cli.ts [options]

Options:
  --filter <regex>    Only run cases whose id matches this regex
  --cases <dir>       Use a different case directory
  --no-store          Skip writing results to disk
  --dry-run           Parse cases and run a stub transport (no LLM calls)
  --diff <runId>      Compare current run to an existing run id
  --help, -h          Show this help

Defaults:
  cases dir:   packages/golden/cases
  results dir: $EIGHT_DATA_DIR/golden/runs (~/.8gent/golden/runs)
`);
}

/**
 * Build a transport that hits the real daemon AgentPool. We import lazily
 * so --dry-run never pays the cost of pulling in the agent stack.
 */
async function buildLiveTransport(): Promise<ChatTransport> {
	const { AgentPool, loadPoolConfig } = (await import("../daemon/agent-pool")) as {
		AgentPool: new (cfg: Record<string, unknown>) => unknown;
		loadPoolConfig: () => Promise<Record<string, unknown> & { model?: string; runtime?: string }>;
	};
	const { bus } = await import("../daemon/events");
	const config = await loadPoolConfig();
	const pool = new AgentPool(config);
	return agentPoolTransport({
		pool: pool as unknown as Parameters<typeof agentPoolTransport>[0]["pool"],
		bus,
		model: config.model ?? "unknown",
		runtime: config.runtime ?? "unknown",
	});
}

/**
 * Stub transport for --dry-run. Returns the prompt verbatim, with a token
 * estimate but no tool calls. Useful for verifying the pipeline (load,
 * grade, write, diff) without burning model calls.
 */
function stubTransport(): ChatTransport {
	return {
		describe() {
			return { model: "stub", runtime: "dry-run" };
		},
		async run({ caseId, prompt }): Promise<AgentRunResult> {
			return {
				caseId,
				prompt,
				response: prompt,
				durationMs: 0,
				toolCalls: [],
				promptTokensEstimate: Math.ceil(prompt.length / 4),
				completionTokensEstimate: 0,
			};
		},
	};
}

const COLORS = {
	reset: "\x1b[0m",
	dim: "\x1b[2m",
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	cyan: "\x1b[36m",
};

function fmtCaseLine(r: CaseResult, idx: number, total: number): string {
	const status = r.passed
		? `${COLORS.green}PASS${COLORS.reset}`
		: `${COLORS.red}FAIL${COLORS.reset}`;
	const score = (r.score * 100).toFixed(0).padStart(3);
	const dur = `${r.durationMs}ms`.padStart(7);
	return `  [${(idx + 1).toString().padStart(3)}/${total}] ${status}  ${score}%  ${dur}  ${r.caseId}`;
}

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		printHelp();
		return 0;
	}

	let cases;
	try {
		cases = loadCasesFromDirectory(args.casesDir);
	} catch (err) {
		console.error(`${COLORS.red}error loading cases:${COLORS.reset} ${(err as Error).message}`);
		return 2;
	}
	console.log(
		`${COLORS.cyan}golden suite${COLORS.reset}  cases=${cases.length}  dir=${args.casesDir}  mode=${args.dryRun ? "dry-run" : "live"}`,
	);

	let transport: ChatTransport;
	try {
		transport = args.dryRun ? stubTransport() : await buildLiveTransport();
	} catch (err) {
		console.error(`${COLORS.red}transport init failed:${COLORS.reset} ${(err as Error).message}`);
		return 2;
	}

	const filter = args.filter ? new RegExp(args.filter) : undefined;
	const total = cases.filter((c) => !filter || filter.test(c.id)).length;

	const { summary, results } = await runGolden({
		cases,
		transport,
		filter,
		onCaseFinish: (r, i) => {
			console.log(fmtCaseLine(r, i, total));
			if (!r.passed) {
				for (const c of r.checks.filter((x) => !x.passed)) {
					console.log(
						`        ${COLORS.dim}- ${c.name}${c.detail ? `: ${c.detail}` : ""}${COLORS.reset}`,
					);
				}
			}
		},
	});

	console.log("");
	console.log(`${COLORS.cyan}summary${COLORS.reset}  runId=${summary.runId}`);
	console.log(`  passed:  ${COLORS.green}${summary.passed}${COLORS.reset}`);
	console.log(
		`  failed:  ${summary.failed > 0 ? COLORS.red : COLORS.dim}${summary.failed}${COLORS.reset}`,
	);
	console.log(`  skipped: ${summary.skipped}`);
	console.log(`  score:   ${(summary.score * 100).toFixed(1)}%`);
	console.log(
		`  latency: p50=${summary.p50DurationMs}ms p95=${summary.p95DurationMs}ms p99=${summary.p99DurationMs}ms`,
	);
	console.log(`  tools:   ${summary.totalToolCalls} calls across ${results.length} cases`);
	console.log(
		`  tokens:  ${summary.totalPromptTokensEstimate} prompt / ${summary.totalCompletionTokensEstimate} completion (estimate)`,
	);
	console.log(`  model:   ${summary.model}  runtime=${summary.runtime}`);

	if (args.store) {
		const layout = writeRun(summary, results);
		console.log(`${COLORS.dim}  wrote ${layout.runDir}${COLORS.reset}`);
	} else {
		console.log(`${COLORS.dim}  (results not persisted - --no-store)${COLORS.reset}`);
	}

	if (args.diffAgainst) {
		try {
			const baseline = loadRun(args.diffAgainst);
			const d = diffRuns({ summary, results }, baseline);
			console.log("");
			console.log(`${COLORS.cyan}diff${COLORS.reset}  baseline=${d.baselineRunId}`);
			console.log(`  score Δ: ${(d.scoreDelta * 100).toFixed(1)}%`);
			console.log(`  passed Δ: ${d.passedDelta}`);
			console.log(`  failed Δ: ${d.failedDelta}`);
			console.log(`  p50 Δ: ${d.p50DeltaMs}ms`);
			console.log(`  p95 Δ: ${d.p95DeltaMs}ms`);
			if (d.regressedCases.length > 0) {
				console.log(`  ${COLORS.red}regressed:${COLORS.reset} ${d.regressedCases.join(", ")}`);
			}
			if (d.improvedCases.length > 0) {
				console.log(`  ${COLORS.green}improved:${COLORS.reset} ${d.improvedCases.join(", ")}`);
			}
		} catch (err) {
			console.error(`${COLORS.red}diff failed:${COLORS.reset} ${(err as Error).message}`);
		}
	}

	return summary.failed === 0 ? 0 : 1;
}

if (import.meta.main) {
	main()
		.then((code) => process.exit(code))
		.catch((err) => {
			console.error(err);
			process.exit(2);
		});
}
