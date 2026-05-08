#!/usr/bin/env bun
// ── Evals CLI ─────────────────────────────────────────────────────
//
// Usage:
//   bun run evals                        # run golden set, print summary
//   bun run evals --baseline             # update baseline.json
//   bun run evals --check                # compare to baseline, exit 1 on regression
//   bun run evals --category tool_use    # filter
//   bun run evals --case TC001           # single case
//   bun run evals --output report.json   # write full report
//
// Env:
//   OPENROUTER_API_KEY     required for real model. Falls back to mock if absent.
//   EVALS_MODEL            override model. Default: qwen/qwen-2.5-72b-instruct:free.
//   EVALS_JUDGE_API_KEY    optional, enables LLM-as-judge for quality_rubric.
//   EVALS_USE_MOCK=1       force mock executor (useful in CI).

import * as fs from "node:fs";
import * as path from "node:path";
import { compare, formatRegressions, loadBaseline, writeBaseline } from "./baseline.js";
import { reportToSnapshot } from "./baseline.js";
import { selectExecutor } from "./executor.js";
import { loadGoldenSet, runEvals, writeReport } from "./runner.js";

interface CliOpts {
	updateBaseline: boolean;
	checkBaseline: boolean;
	category?: string;
	caseId?: string;
	outputPath?: string;
	goldenPath: string;
	baselinePath: string;
	concurrency: number;
	verbose: boolean;
}

function parseArgs(): CliOpts {
	const args = process.argv.slice(2);
	const opts: CliOpts = {
		updateBaseline: false,
		checkBaseline: false,
		goldenPath: "evals/golden-set.json",
		baselinePath: "evals/baseline.json",
		concurrency: 1,
		verbose: false,
	};
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		const next = args[i + 1];
		switch (a) {
			case "--baseline":
			case "--update-baseline":
				opts.updateBaseline = true;
				break;
			case "--check":
				opts.checkBaseline = true;
				break;
			case "--category":
				opts.category = next;
				i++;
				break;
			case "--case":
				opts.caseId = next;
				i++;
				break;
			case "--output":
				opts.outputPath = next;
				i++;
				break;
			case "--golden":
				if (next) opts.goldenPath = next;
				i++;
				break;
			case "--baseline-path":
				if (next) opts.baselinePath = next;
				i++;
				break;
			case "--concurrency":
				if (next) opts.concurrency = Math.max(1, Number(next));
				i++;
				break;
			case "--verbose":
			case "-v":
				opts.verbose = true;
				break;
			case "--help":
			case "-h":
				printHelp();
				process.exit(0);
		}
	}
	return opts;
}

function printHelp(): void {
	console.log(`8gent evals — golden test sets and measurement baselines

USAGE
  bun run evals [flags]

FLAGS
  --baseline           write current run as the new baseline
  --check              compare run to baseline; exit 1 on regression (CI)
  --category <name>    filter by category (tool_use, reasoning, code_gen, memory, multi_step)
  --case <id>          run a single case
  --output <path>      write full JSON report to path
  --golden <path>      golden set path (default: evals/golden-set.json)
  --baseline-path <p>  baseline path (default: evals/baseline.json)
  --concurrency <n>    parallel runs (default 1)
  --verbose            per-case logging
  --help               this message

ENV
  OPENROUTER_API_KEY   required for real model; falls back to mock executor
  EVALS_MODEL          override model id
  EVALS_JUDGE_API_KEY  enables LLM-as-judge for quality_rubric scoring
  EVALS_USE_MOCK=1     force mock (CI without API keys)
`);
}

function fmtPct(n: number): string {
	return `${(n * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
	const opts = parseArgs();
	const goldenAbs = path.resolve(process.cwd(), opts.goldenPath);
	if (!fs.existsSync(goldenAbs)) {
		console.error(`Golden set not found at ${goldenAbs}`);
		process.exit(2);
	}
	const goldenSet = loadGoldenSet(goldenAbs);
	const executor = selectExecutor();

	console.log(`[evals] executor=${executor.name}`);
	console.log(`[evals] cases=${goldenSet.cases.length} version=${goldenSet.version}`);

	const judgeKey = process.env.EVALS_JUDGE_API_KEY ?? process.env.OPENROUTER_API_KEY;

	const report = await runEvals({
		executor,
		goldenSet,
		categories: opts.category ? [opts.category] : undefined,
		caseIds: opts.caseId ? [opts.caseId] : undefined,
		concurrency: opts.concurrency,
		scorer: judgeKey ? { judgeApiKey: judgeKey } : undefined,
		onCaseStart: opts.verbose ? (c) => console.log(`  > ${c.id} ${c.name}`) : undefined,
		onCaseEnd: opts.verbose
			? (r) =>
					console.log(
						`    ${r.score.passed ? "PASS" : "FAIL"} score=${r.score.score} latency=${r.execution.latencyMs}ms`,
					)
			: undefined,
	});

	console.log("");
	console.log(
		`Pass rate:  ${fmtPct(report.summary.passRate)} (${report.summary.passed}/${report.summary.total})`,
	);
	console.log(`Mean score: ${report.summary.meanScore}`);
	console.log(
		`Latency:    p50=${report.summary.latency.p50}ms p95=${report.summary.latency.p95}ms p99=${report.summary.latency.p99}ms`,
	);
	console.log("By category:");
	for (const [k, v] of Object.entries(report.summary.categoryBreakdown)) {
		console.log(`  ${k.padEnd(12)} ${v.passed}/${v.total}`);
	}

	if (opts.outputPath) {
		const out = path.resolve(process.cwd(), opts.outputPath);
		writeReport(out, report);
		console.log(`Wrote report to ${out}`);
	}

	const baselineAbs = path.resolve(process.cwd(), opts.baselinePath);

	if (opts.updateBaseline) {
		writeBaseline(baselineAbs, reportToSnapshot(report));
		console.log(`Updated baseline at ${baselineAbs}`);
		return;
	}

	if (opts.checkBaseline) {
		const baseline = loadBaseline(baselineAbs);
		if (!baseline) {
			console.warn(`No baseline at ${baselineAbs}. Run with --baseline to create one.`);
			return;
		}
		const diff = compare(baseline, report);
		console.log("");
		console.log(formatRegressions(diff));
		if (diff.hasRegressions) {
			console.error(`\nFAIL: ${diff.regressions.length} regression(s) vs baseline.`);
			process.exit(1);
		}
		console.log("\nOK: no regressions vs baseline.");
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
