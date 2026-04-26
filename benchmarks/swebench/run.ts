#!/usr/bin/env bun
/**
 * SWE-bench Evaluation CLI
 *
 * Usage:
 *   bun run benchmarks/swebench/run.ts
 *   bun run benchmarks/swebench/run.ts --subset 10
 *   bun run benchmarks/swebench/run.ts --timeout 300000 --model qwen3.5:latest
 *   bun run benchmarks/swebench/run.ts --output ./my-results
 *   bun run benchmarks/swebench/run.ts --refresh
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadTasks, refreshDataset } from "./loader";
import { type TaskResult, runAllTasks } from "./runner";
import { printSummary, saveReport, score } from "./scorer";

interface CLIOptions {
	subset?: number;
	timeout: number;
	model: string;
	output: string;
	refresh: boolean;
}

function parseArgs(): CLIOptions {
	const args = process.argv.slice(2);
	const opts: CLIOptions = {
		timeout: 5 * 60 * 1000,
		model: process.env.OLLAMA_MODEL || "qwen3.5:latest",
		output: path.join(__dirname, "results"),
		refresh: false,
	};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i],
			next = args[i + 1];
		switch (arg) {
			case "--subset":
			case "-n":
				opts.subset = Number.parseInt(next, 10);
				i++;
				break;
			case "--timeout":
			case "-t":
				opts.timeout = Number.parseInt(next, 10);
				i++;
				break;
			case "--model":
			case "-m":
				opts.model = next;
				i++;
				break;
			case "--output":
			case "-o":
				opts.output = next;
				i++;
				break;
			case "--refresh":
				opts.refresh = true;
				break;
			case "--help":
			case "-h":
				console.log(`SWE-bench Lite Evaluation Harness

Options:
  --subset, -n <N>    First N tasks only (default: all)
  --timeout, -t <ms>  Per-task timeout (default: 300000)
  --model, -m <name>  Model (default: qwen3.5:latest)
  --output, -o <dir>  Results dir (default: benchmarks/swebench/results/)
  --refresh           Re-download dataset
  --help, -h          Show this help`);
				process.exit(0);
		}
	}
	return opts;
}

const c = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	green: "\x1b[32m",
	red: "\x1b[31m",
	cyan: "\x1b[36m",
};

async function main(): Promise<void> {
	const opts = parseArgs();

	console.log(`${c.cyan}${"=".repeat(60)}${c.reset}`);
	console.log(`${c.bold}  SWE-bench Lite - 8gent Evaluation Harness${c.reset}`);
	console.log(`${c.cyan}${"=".repeat(60)}${c.reset}\n`);
	console.log(`  Model:    ${c.bold}${opts.model}${c.reset}`);
	console.log(`  Timeout:  ${c.dim}${opts.timeout / 1000}s per task${c.reset}`);
	if (opts.subset)
		console.log(`  Subset:   ${c.dim}first ${opts.subset} tasks${c.reset}`);

	if (opts.refresh) await refreshDataset();
	const tasks = await loadTasks(opts.subset);

	const workDir = path.join(os.tmpdir(), `swebench-${Date.now()}`);
	fs.mkdirSync(workDir, { recursive: true });
	console.log(`  Work dir: ${c.dim}${workDir}${c.reset}\n`);

	const results = await runAllTasks(
		tasks,
		workDir,
		{ timeout_ms: opts.timeout, model: opts.model },
		(idx: number, total: number, r: TaskResult) => {
			const status = r.passed
				? `${c.green}PASS${c.reset}`
				: `${c.red}FAIL${c.reset}`;
			const err = r.error ? ` ${c.dim}(${r.error.slice(0, 60)})${c.reset}` : "";
			const dur = `${c.dim}${(r.duration_ms / 1000).toFixed(1)}s${c.reset}`;
			console.log(
				`  [${String(idx).padStart(3)}/${total}] ${r.repo.padEnd(30)} ${status} ${dur}${err}`,
			);
		},
	);

	const report = score(results, opts.model);
	const reportPath = saveReport(report, opts.output);
	printSummary(report);
	console.log(`  Report saved: ${c.bold}${reportPath}${c.reset}\n`);

	try {
		fs.rmSync(workDir, { recursive: true, force: true });
	} catch {
		console.log(`  ${c.dim}Work dir not fully cleaned: ${workDir}${c.reset}`);
	}
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
