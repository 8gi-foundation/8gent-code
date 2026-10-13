#!/usr/bin/env bun
/**
 * 8gent Code Benchmark Runner
 *
 * Executes benchmarks against a real, locally running model (Ollama by
 * default) and grades the output with execution-based + keyword grading.
 * There is no mock path: if the model cannot be reached or produces no
 * output, this exits non-zero instead of reporting a score.
 *
 * Usage:
 *   bun run benchmarks/runner.ts                    # Run all benchmarks
 *   bun run benchmarks/runner.ts --category bug-fixing
 *   bun run benchmarks/runner.ts --bench BF001
 *   bun run benchmarks/runner.ts --output json
 *   bun run benchmarks/runner.ts --dry-run
 *   bun run benchmarks/runner.ts --model qwen3:8b
 *   bun run benchmarks/runner.ts --resume benchmarks/results/run1 --seed 300
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { grade } from "./autoresearch/execution-grader";
import { getSystemPrompt } from "./autoresearch/system-prompt";
import { loadDone, openRun, saveResult } from "./run-store";
import type { BenchmarkCategory, BenchmarkDefinition, CombinedGradeResult } from "./types";

// Benchmark categories whose fixtures match the current execution-graded
// BenchmarkDefinition shape (id, category, title, difficulty, prompt,
// keywords, testExecution). This is the same set benchmarks/autoresearch/
// multi-model-harness.ts runs -- reused rather than reinvented.
import { agenticBenchmarks } from "./categories/agentic/benchmarks";
import { battleTestBenchmarks } from "./categories/battle-test/benchmarks";
import { bugFixingBenchmarks } from "./categories/bug-fixing/benchmarks";
import { featureImplementationBenchmarks } from "./categories/feature-implementation/benchmarks";
import { fileManipulationBenchmarks } from "./categories/file-manipulation/benchmarks";
import { fullstackBenchmarks } from "./categories/fullstack/benchmarks";
import { uiDesignBenchmarks } from "./categories/ui-design/benchmarks";

// All benchmarks combined
const ALL_BENCHMARKS: BenchmarkDefinition[] = [
	...fileManipulationBenchmarks,
	...bugFixingBenchmarks,
	...featureImplementationBenchmarks,
	...fullstackBenchmarks,
	...agenticBenchmarks,
	...uiDesignBenchmarks,
	...battleTestBenchmarks,
];

type Difficulty = BenchmarkDefinition["difficulty"];

interface BenchmarkResult {
	benchmarkId: string;
	code: string | null;
	grade: CombinedGradeResult;
	tokensUsed: number;
	duration: number;
}

interface BenchmarkSuiteResult {
	suiteId: string;
	timestamp: string;
	model: string;
	provider: string;
	overallScore: number;
	categoryScores: Record<string, number>;
	difficultyScores: Record<string, number>;
	totalTokensUsed: number;
	results: BenchmarkResult[];
	seed?: number;
	/** Set when --resume was used: items loaded from disk instead of run now. */
	resumed?: { dir: string; skipped: string[] };
	stats: {
		total: number;
		passed: number;
		failed: number;
		avgScore: number;
	};
}

// Colors for terminal output
const colors = {
	reset: "\x1b[0m",
	bright: "\x1b[1m",
	dim: "\x1b[2m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	red: "\x1b[31m",
	cyan: "\x1b[36m",
	magenta: "\x1b[35m",
	blue: "\x1b[34m",
};

function log(msg: string, color = ""): void {
	console.log(`${color}${msg}${colors.reset}`);
}

function getScoreColor(score: number): string {
	if (score >= 90) return colors.green;
	if (score >= 70) return colors.yellow;
	return colors.red;
}

function getDifficultyColor(difficulty: Difficulty): string {
	switch (difficulty) {
		case "easy":
			return colors.green;
		case "medium":
			return colors.yellow;
		case "hard":
			return colors.magenta;
	}
}

interface RunnerOptions {
	category?: BenchmarkCategory;
	benchmarkId?: string;
	outputFormat: "terminal" | "json" | "markdown";
	dryRun: boolean;
	verbose: boolean;
	model?: string;
	provider?: string;
	resumeDir?: string;
	seed?: number;
}

/**
 * Parse command line arguments
 */
function parseArgs(): RunnerOptions {
	const args = process.argv.slice(2);
	const options: RunnerOptions = {
		outputFormat: "terminal",
		dryRun: false,
		verbose: false,
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const next = args[i + 1];

		switch (arg) {
			case "--category":
			case "-c":
				options.category = next as BenchmarkCategory;
				i++;
				break;
			case "--bench":
			case "-b":
				options.benchmarkId = next;
				i++;
				break;
			case "--output":
			case "-o":
				options.outputFormat = next as "terminal" | "json" | "markdown";
				i++;
				break;
			case "--dry-run":
				options.dryRun = true;
				break;
			case "--verbose":
			case "-v":
				options.verbose = true;
				break;
			case "--model":
				options.model = next;
				i++;
				break;
			case "--provider":
				options.provider = next;
				i++;
				break;
			case "--resume":
				options.resumeDir = next;
				i++;
				break;
			case "--seed":
				options.seed = Number(next);
				if (!Number.isInteger(options.seed)) {
					console.error(`--seed must be an integer, got "${next}"`);
					process.exit(1);
				}
				i++;
				break;
			case "--help":
			case "-h":
				printHelp();
				process.exit(0);
		}
	}

	return options;
}

function printHelp(): void {
	console.log(`
8gent Code Benchmark Runner

Calls a real, locally running model for every benchmark and grades the
output with execution tests + keyword matching. Fails non-zero (no score)
if the model provider is unreachable.

Usage: bun run benchmarks/runner.ts [options]

Options:
  --category, -c <name>   Run only benchmarks in this category
  --bench, -b <id>        Run only the specified benchmark
  --output, -o <format>   Output format: terminal, json, markdown
  --dry-run               List benchmarks without running them
  --verbose, -v           Show detailed output
  --model <name>          Ollama model to use (default: llama3.2:3b, or $OLLAMA_MODEL)
  --provider <name>       Model provider (only "ollama" is wired up)
  --resume <dir>          Save each finished item to <dir>/<id>.json and skip
                          items already saved there (refuses a model/seed change)
  --seed <n>              Pass a sampling seed to the model and record it
  --help, -h              Show this help message

Categories:
  file-manipulation       Single file create/edit/refactor
  bug-fixing              Debug and fix bugs
  feature-implementation  Implement new features
  fullstack               Multi-layer REST/API features
  agentic                 Multi-step tool-using tasks
  ui-design               HTML/CSS UI generation
  battle-test             Real-world freelance-grade contracts

Examples:
  bun run benchmarks/runner.ts --category bug-fixing
  bun run benchmarks/runner.ts --bench BF001 --verbose
  bun run benchmarks/runner.ts --output json > results.json
  bun run benchmarks/runner.ts --dry-run
  bun run benchmarks/runner.ts --model qwen3:8b
`);
}

/**
 * Filter benchmarks based on options
 */
function filterBenchmarks(
	benchmarks: BenchmarkDefinition[],
	options: RunnerOptions,
): BenchmarkDefinition[] {
	let filtered = benchmarks;

	if (options.category) {
		filtered = filtered.filter((b) => b.category === options.category);
	}

	if (options.benchmarkId) {
		filtered = filtered.filter((b) => b.id === options.benchmarkId);
	}

	return filtered;
}

/**
 * Load fixture files for a benchmark
 */
function loadFixtures(benchmark: BenchmarkDefinition): string {
	const benchmarkDir = path.join(__dirname);
	let content = "";

	for (const fixturePath of benchmark.fixtures ?? []) {
		const fullPath = path.join(benchmarkDir, fixturePath);
		if (fs.existsSync(fullPath)) {
			content += `// File: ${fixturePath}\n`;
			content += fs.readFileSync(fullPath, "utf-8");
			content += "\n\n";
		}
	}

	return content;
}

// ── Real model call (no mock path) ─────────────────────────────────

interface ChatMessage {
	role: "system" | "user";
	content: string;
}

const DEFAULT_PROVIDER = "ollama";
const DEFAULT_MODEL = process.env.OLLAMA_MODEL ?? "llama3.2:3b";
const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const CALL_TIMEOUT_MS = Number(process.env.BENCHMARK_CALL_TIMEOUT_MS ?? 120_000);

/**
 * Confirm the configured model is actually reachable and pulled before
 * claiming any score. Throws (never returns a fabricated result) if not.
 */
async function probeOllama(model: string): Promise<void> {
	let res: Response;
	try {
		res = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(3000) });
	} catch (err) {
		throw new Error(
			`Cannot reach Ollama at ${OLLAMA_HOST}. Is it running? (${(err as Error).message})`,
		);
	}
	if (!res.ok) {
		throw new Error(`Ollama at ${OLLAMA_HOST} returned HTTP ${res.status}`);
	}
	const json: any = await res.json();
	const names: string[] = (json.models ?? []).map((m: any) => m.name);
	if (!names.includes(model)) {
		throw new Error(
			`Model "${model}" is not pulled in Ollama. Available: ${names.join(", ") || "none"}. Run: ollama pull ${model}`,
		);
	}
}

async function callOllama(
	model: string,
	messages: ChatMessage[],
	seed?: number,
): Promise<{ content: string; tokensUsed: number }> {
	const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
		body: JSON.stringify({
			model,
			messages,
			stream: false,
			options: seed === undefined ? { temperature: 0.2 } : { temperature: 0.2, seed },
		}),
	});
	if (!res.ok) {
		throw new Error(`Ollama chat call failed: HTTP ${res.status} ${await res.text()}`);
	}
	const json: any = await res.json();
	const content: string = json.message?.content ?? "";
	if (!content.trim()) {
		throw new Error("Ollama returned an empty response");
	}
	const tokensUsed = (json.prompt_eval_count ?? 0) + (json.eval_count ?? 0);
	return { content, tokensUsed };
}

/**
 * Execute a benchmark against a real model. There is no mock/placeholder
 * path -- if the provider is unreachable, unsupported, or errors, this
 * throws and the runner exits non-zero instead of reporting a score.
 */
async function executeBenchmark(
	benchmark: BenchmarkDefinition,
	options: RunnerOptions,
): Promise<{ output: string; tokensUsed: number; duration: number }> {
	const provider = options.provider ?? DEFAULT_PROVIDER;
	if (provider !== "ollama") {
		throw new Error(
			`Unsupported provider "${provider}". Only "ollama" (local, default) is wired up. Refusing to fabricate a result.`,
		);
	}
	const model = options.model ?? DEFAULT_MODEL;

	const startTime = Date.now();

	// Fail loudly, before doing any work, if the model isn't actually there.
	await probeOllama(model);

	const fixtureContent = loadFixtures(benchmark);
	const userPrompt = fixtureContent
		? `${benchmark.prompt}\n\nContext:\n${fixtureContent}`
		: benchmark.prompt;

	const { content, tokensUsed } = await callOllama(
		model,
		[
			{ role: "system", content: getSystemPrompt() },
			{ role: "user", content: userPrompt },
		],
		options.seed,
	);

	const duration = Date.now() - startTime;

	return { output: content, tokensUsed, duration };
}

/**
 * Run all selected benchmarks
 */
async function runBenchmarks(
	benchmarks: BenchmarkDefinition[],
	options: RunnerOptions,
): Promise<BenchmarkSuiteResult> {
	const results: BenchmarkResult[] = [];
	const resumeDir = options.resumeDir;
	const done = new Map<string, BenchmarkResult>();
	const skipped: string[] = [];
	if (resumeDir) {
		openRun(resumeDir, {
			model: options.model ?? DEFAULT_MODEL,
			provider: options.provider ?? DEFAULT_PROVIDER,
			seed: options.seed,
		});
		for (const [id, r] of loadDone<BenchmarkResult>(resumeDir)) done.set(id, r);
	}

	log(
		"\n╔══════════════════════════════════════════════════════════════════════════╗",
		colors.cyan,
	);
	log("║  8gent Code Benchmark Suite                                               ║", colors.cyan);
	log("║  Comprehensive Coding Capability Assessment                               ║", colors.cyan);
	log(
		"╚══════════════════════════════════════════════════════════════════════════╝\n",
		colors.cyan,
	);

	log(`Running ${benchmarks.length} benchmarks...\n`, colors.bright);

	for (const benchmark of benchmarks) {
		const diffColor = getDifficultyColor(benchmark.difficulty);

		if (options.verbose) {
			log("\n─────────────────────────────────────────────────────────────", colors.dim);
			log(`📋 ${benchmark.id}: ${benchmark.title}`, colors.bright);
			log(
				`   Category: ${benchmark.category} | Difficulty: ${diffColor}${benchmark.difficulty}${colors.reset}`,
			);
		} else {
			process.stdout.write(`  ${benchmark.id.padEnd(8)} ${benchmark.title.padEnd(35)} `);
		}

		const previous = done.get(benchmark.id);
		if (previous) {
			results.push(previous);
			skipped.push(benchmark.id);
			log(
				`${getScoreColor(previous.grade.score)}${previous.grade.score.toString().padStart(3)}%${colors.reset} (resumed)`,
			);
			continue;
		}

		// Execute benchmark against a real model (throws + exits non-zero on failure)
		const { output, tokensUsed, duration } = await executeBenchmark(benchmark, options);

		// Grade result: execution tests (bun test) where available, else keywords only
		const { code, result: combined } = await grade(output, benchmark);
		const result: BenchmarkResult = {
			benchmarkId: benchmark.id,
			code,
			grade: combined,
			tokensUsed,
			duration,
		};
		results.push(result);
		if (resumeDir) saveResult(resumeDir, result);

		// Display result
		const scoreColor = getScoreColor(combined.score);
		if (options.verbose) {
			log("\n   Results:", colors.bright);
			log(`     Method:         ${combined.method}`);
			if (combined.execution) {
				log(
					`     Execution:      ${scoreColor}${combined.execution.score.toString().padStart(3)}%${colors.reset} (${combined.execution.passedTests}/${combined.execution.totalTests} tests)`,
				);
			}
			log(
				`     Keywords:       ${combined.keyword.score.toString().padStart(3)}% (${combined.keyword.matchedKeywords.length}/${combined.keyword.matchedKeywords.length + combined.keyword.missedKeywords.length})`,
			);
			log(
				`     Overall:        ${scoreColor}${combined.score.toString().padStart(3)}%${colors.reset}`,
			);
			log(`     Tokens:         ${tokensUsed}`);
			log(`     Duration:       ${duration}ms`);
		} else {
			log(`${scoreColor}${combined.score.toString().padStart(3)}%${colors.reset}`);
		}
	}

	// Calculate aggregated stats
	const categoryScores: Record<string, number> = {};
	const difficultyScores: Record<string, number> = {};

	const categoryCounts: Record<string, { sum: number; count: number }> = {};
	const difficultyCounts: Record<string, { sum: number; count: number }> = {};

	for (let i = 0; i < benchmarks.length; i++) {
		const benchmark = benchmarks[i];
		const result = results[i];

		if (!categoryCounts[benchmark.category]) {
			categoryCounts[benchmark.category] = { sum: 0, count: 0 };
		}
		categoryCounts[benchmark.category].sum += result.grade.score;
		categoryCounts[benchmark.category].count++;

		if (!difficultyCounts[benchmark.difficulty]) {
			difficultyCounts[benchmark.difficulty] = { sum: 0, count: 0 };
		}
		difficultyCounts[benchmark.difficulty].sum += result.grade.score;
		difficultyCounts[benchmark.difficulty].count++;
	}

	for (const [category, { sum, count }] of Object.entries(categoryCounts)) {
		categoryScores[category] = Math.round(sum / count);
	}

	for (const [difficulty, { sum, count }] of Object.entries(difficultyCounts)) {
		difficultyScores[difficulty] = Math.round(sum / count);
	}

	const totalTokensUsed = results.reduce((sum, r) => sum + r.tokensUsed, 0);
	const avgScore = results.reduce((sum, r) => sum + r.grade.score, 0) / results.length;
	const passedCount = results.filter((r) => r.grade.score >= 70).length;

	const suiteResult: BenchmarkSuiteResult = {
		suiteId: `suite_${Date.now()}`,
		timestamp: new Date().toISOString(),
		model: options.model || DEFAULT_MODEL,
		provider: options.provider || DEFAULT_PROVIDER,
		overallScore: Math.round(avgScore),
		categoryScores,
		difficultyScores,
		totalTokensUsed,
		results,
		...(options.seed === undefined ? {} : { seed: options.seed }),
		...(resumeDir ? { resumed: { dir: resumeDir, skipped } } : {}),
		stats: {
			total: results.length,
			passed: passedCount,
			failed: results.length - passedCount,
			avgScore: Math.round(avgScore),
		},
	};

	return suiteResult;
}

/**
 * Output results in requested format
 */
function outputResults(suiteResult: BenchmarkSuiteResult, options: RunnerOptions): void {
	switch (options.outputFormat) {
		case "json":
			console.log(JSON.stringify(suiteResult, null, 2));
			break;

		case "markdown":
			outputMarkdown(suiteResult);
			break;
		default:
			outputTerminal(suiteResult);
			break;
	}
}

/** "N of M items loaded from <dir>", or null when the run was not resumed. */
function resumedLabel(suiteResult: BenchmarkSuiteResult): string | null {
	if (!suiteResult.resumed) return null;
	const { dir, skipped } = suiteResult.resumed;
	return `${skipped.length} of ${suiteResult.results.length} items loaded from ${dir}`;
}

function outputTerminal(suiteResult: BenchmarkSuiteResult): void {
	log(
		"\n╔══════════════════════════════════════════════════════════════════════════╗",
		colors.cyan,
	);
	log("║  BENCHMARK RESULTS                                                        ║", colors.cyan);
	log("╠══════════════════════════════════════════════════════════════════════════╣", colors.cyan);

	const scoreColor = getScoreColor(suiteResult.overallScore);
	log(
		`║  Overall Score:        ${scoreColor}${suiteResult.overallScore.toString().padStart(3)}%${colors.reset}${" ".repeat(48)}║`,
		colors.cyan,
	);
	log(
		`║  Passed:               ${suiteResult.stats.passed}/${suiteResult.stats.total}${" ".repeat(54)}║`,
		colors.cyan,
	);
	log(
		`║  Model:                ${suiteResult.model} (${suiteResult.provider})${" ".repeat(Math.max(0, 40 - suiteResult.model.length - suiteResult.provider.length))}║`,
		colors.cyan,
	);
	log(
		`║  Total Tokens Used:    ${suiteResult.totalTokensUsed}${" ".repeat(50)}║`,
		colors.cyan,
	);
	log(`║  Seed:                 ${suiteResult.seed ?? "unset"}`, colors.cyan);
	const resumed = resumedLabel(suiteResult);
	if (resumed) log(`║  Resumed:              ${resumed}`, colors.cyan);

	log("╠══════════════════════════════════════════════════════════════════════════╣", colors.cyan);
	log("║  Scores by Category:                                                      ║", colors.cyan);

	for (const [category, score] of Object.entries(suiteResult.categoryScores)) {
		const catColor = getScoreColor(score);
		log(
			`║    ${category.padEnd(25)} ${catColor}${score.toString().padStart(3)}%${colors.reset}${" ".repeat(42)}║`,
			colors.cyan,
		);
	}

	log("╠══════════════════════════════════════════════════════════════════════════╣", colors.cyan);
	log("║  Scores by Difficulty:                                                    ║", colors.cyan);

	for (const [difficulty, score] of Object.entries(suiteResult.difficultyScores)) {
		const diffColor = getScoreColor(score);
		log(
			`║    ${difficulty.padEnd(25)} ${diffColor}${score.toString().padStart(3)}%${colors.reset}${" ".repeat(42)}║`,
			colors.cyan,
		);
	}

	log(
		"╚══════════════════════════════════════════════════════════════════════════╝\n",
		colors.cyan,
	);

	// Save results to file
	const resultsDir = path.join(__dirname, "results");
	if (!fs.existsSync(resultsDir)) {
		fs.mkdirSync(resultsDir, { recursive: true });
	}

	const resultsFile = path.join(resultsDir, `benchmark-${Date.now()}.json`);
	fs.writeFileSync(resultsFile, JSON.stringify(suiteResult, null, 2));
	log(`Results saved to: ${resultsFile}`, colors.dim);
}

function outputMarkdown(suiteResult: BenchmarkSuiteResult): void {
	const md = `# 8gent Code Benchmark Results

**Suite ID:** ${suiteResult.suiteId}
**Timestamp:** ${suiteResult.timestamp}
**Model:** ${suiteResult.model}
**Provider:** ${suiteResult.provider}
**Seed:** ${suiteResult.seed ?? "unset"}
${resumedLabel(suiteResult) ? `**Resumed:** ${resumedLabel(suiteResult)}\n` : ""}
## Summary

| Metric | Value |
|--------|-------|
| Overall Score | ${suiteResult.overallScore}% |
| Passed | ${suiteResult.stats.passed}/${suiteResult.stats.total} |
| Total Tokens Used | ${suiteResult.totalTokensUsed} |

## Scores by Category

| Category | Score |
|----------|-------|
${Object.entries(suiteResult.categoryScores)
	.map(([cat, score]) => `| ${cat} | ${score}% |`)
	.join("\n")}

## Scores by Difficulty

| Difficulty | Score |
|------------|-------|
${Object.entries(suiteResult.difficultyScores)
	.map(([diff, score]) => `| ${diff} | ${score}% |`)
	.join("\n")}

## Individual Results

| Benchmark | Category | Difficulty | Score | Tokens | Time |
|-----------|----------|------------|-------|--------|------|
${suiteResult.results
	.map(
		(r) =>
			`| ${r.benchmarkId} | ${
				ALL_BENCHMARKS.find((b) => b.id === r.benchmarkId)?.category || "N/A"
			} | ${
				ALL_BENCHMARKS.find((b) => b.id === r.benchmarkId)?.difficulty || "N/A"
			} | ${r.grade.score}% | ${r.tokensUsed} | ${r.duration}ms |`,
	)
	.join("\n")}

---
*Generated by 8gent Code Benchmark Suite*
`;

	console.log(md);
}

/**
 * List benchmarks (dry run)
 */
function listBenchmarks(benchmarks: BenchmarkDefinition[]): void {
	log("\n📋 Available Benchmarks:\n", colors.bright);

	const byCategory: Record<string, BenchmarkDefinition[]> = {};
	for (const b of benchmarks) {
		if (!byCategory[b.category]) {
			byCategory[b.category] = [];
		}
		byCategory[b.category].push(b);
	}

	for (const [category, items] of Object.entries(byCategory)) {
		log(`\n${category}:`, colors.cyan);
		for (const b of items) {
			const diffColor = getDifficultyColor(b.difficulty);
			log(
				`  ${b.id.padEnd(8)} ${b.title.padEnd(35)} ${diffColor}${b.difficulty.padEnd(8)}${colors.reset}`,
			);
		}
	}

	log(`\nTotal: ${benchmarks.length} benchmarks\n`, colors.dim);
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
	const options = parseArgs();

	// Filter benchmarks
	const benchmarks = filterBenchmarks(ALL_BENCHMARKS, options);

	if (benchmarks.length === 0) {
		log("No benchmarks found matching the specified criteria.", colors.red);
		process.exit(1);
	}

	if (options.dryRun) {
		listBenchmarks(benchmarks);
		return;
	}

	// Run benchmarks
	const suiteResult = await runBenchmarks(benchmarks, options);

	// Output results
	outputResults(suiteResult, options);
}

main().catch((err) => {
	console.error("Benchmark runner error:", err);
	process.exit(1);
});
