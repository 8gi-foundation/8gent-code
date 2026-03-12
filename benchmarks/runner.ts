#!/usr/bin/env bun
/**
 * 8gent Code Benchmark Runner
 *
 * Comprehensive benchmark runner following Andrej Karpathy's auto-research methodology.
 * Executes benchmarks, grades results, and outputs scores.
 *
 * Usage:
 *   bun run benchmarks/runner.ts                    # Run all benchmarks
 *   bun run benchmarks/runner.ts --category bug-fixing
 *   bun run benchmarks/runner.ts --bench BF001
 *   bun run benchmarks/runner.ts --output json
 *   bun run benchmarks/runner.ts --dry-run
 */

import * as fs from "fs";
import * as path from "path";
import type {
  BenchmarkDefinition,
  BenchmarkResult,
  BenchmarkSuiteResult,
  BenchmarkCategory,
  Difficulty,
} from "./types";
import { BenchmarkGrader } from "./grader";

// Import all benchmark categories
import { fileManipulationBenchmarks } from "./categories/file-manipulation/benchmarks";
import { multiFileBenchmarks } from "./categories/multi-file/benchmarks";
import { bugFixingBenchmarks } from "./categories/bug-fixing/benchmarks";
import { featureImplementationBenchmarks } from "./categories/feature-implementation/benchmarks";
import { codeReviewBenchmarks } from "./categories/code-review/benchmarks";
import { testGenerationBenchmarks } from "./categories/test-generation/benchmarks";
import { documentationBenchmarks } from "./categories/documentation/benchmarks";
// New expanded categories
import { threejsBenchmarks } from "./categories/threejs/benchmarks";
import { reactNativeBenchmarks } from "./categories/react-native/benchmarks";
import { nextjsBenchmarks } from "./categories/nextjs/benchmarks";
import { creativeBenchmarks } from "./categories/creative/benchmarks";
import { humanSkillsBenchmarks } from "./categories/human-skills/benchmarks";

// All benchmarks combined
const ALL_BENCHMARKS: BenchmarkDefinition[] = [
  ...fileManipulationBenchmarks,
  ...multiFileBenchmarks,
  ...bugFixingBenchmarks,
  ...featureImplementationBenchmarks,
  ...codeReviewBenchmarks,
  ...testGenerationBenchmarks,
  ...documentationBenchmarks,
  // Expanded categories
  ...threejsBenchmarks,
  ...reactNativeBenchmarks,
  ...nextjsBenchmarks,
  ...creativeBenchmarks,
  ...humanSkillsBenchmarks,
];

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

function log(msg: string, color: string = ""): void {
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
    case "expert":
      return colors.red;
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

Usage: bun run benchmarks/runner.ts [options]

Options:
  --category, -c <name>   Run only benchmarks in this category
  --bench, -b <id>        Run only the specified benchmark
  --output, -o <format>   Output format: terminal, json, markdown
  --dry-run               List benchmarks without running them
  --verbose, -v           Show detailed output
  --model <name>          Model name for results
  --provider <name>       Provider name for results
  --help, -h              Show this help message

Categories:
  file-manipulation       Single file create/edit/refactor
  multi-file              Multi-file coordination
  bug-fixing              Debug and fix bugs
  feature-implementation  Implement new features
  code-review             Review code for issues
  test-generation         Generate test suites
  documentation           Generate documentation

Examples:
  bun run benchmarks/runner.ts --category bug-fixing
  bun run benchmarks/runner.ts --bench BF001 --verbose
  bun run benchmarks/runner.ts --output json > results.json
  bun run benchmarks/runner.ts --dry-run
`);
}

/**
 * Filter benchmarks based on options
 */
function filterBenchmarks(
  benchmarks: BenchmarkDefinition[],
  options: RunnerOptions
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

  for (const fixturePath of benchmark.fixtures) {
    const fullPath = path.join(benchmarkDir, fixturePath);
    if (fs.existsSync(fullPath)) {
      content += `// File: ${fixturePath}\n`;
      content += fs.readFileSync(fullPath, "utf-8");
      content += "\n\n";
    }
  }

  return content;
}

/**
 * Simulate running a benchmark (placeholder for actual agent execution)
 */
async function executeBenchmark(
  benchmark: BenchmarkDefinition,
  _options: RunnerOptions
): Promise<{ output: string; tokensUsed: number; duration: number }> {
  const startTime = Date.now();

  // Load fixtures
  const fixtureContent = loadFixtures(benchmark);

  // In a real implementation, this would:
  // 1. Send the prompt + fixtures to the agent
  // 2. Capture the agent's response
  // 3. Track token usage

  // Placeholder: simulate processing time and return mock output
  await new Promise((resolve) => setTimeout(resolve, 100));

  const duration = Date.now() - startTime;

  // Mock output - in production, this comes from the agent
  const mockOutput = `
// Mock implementation for ${benchmark.id}
// This would be replaced by actual agent output

${fixtureContent.slice(0, 500)}...

// Agent would complete the implementation here
export function solution() {
  // Implementation
}
`;

  return {
    output: mockOutput,
    tokensUsed: Math.floor(mockOutput.length / 4), // Rough estimate
    duration,
  };
}

/**
 * Run all selected benchmarks
 */
async function runBenchmarks(
  benchmarks: BenchmarkDefinition[],
  options: RunnerOptions
): Promise<BenchmarkSuiteResult> {
  const results: BenchmarkResult[] = [];
  const grader = new BenchmarkGrader(path.join(__dirname, "work"));

  // Ensure work directory exists
  const workDir = path.join(__dirname, "work");
  if (!fs.existsSync(workDir)) {
    fs.mkdirSync(workDir, { recursive: true });
  }

  log("\n╔══════════════════════════════════════════════════════════════════════════╗", colors.cyan);
  log("║  8gent Code Benchmark Suite                                               ║", colors.cyan);
  log("║  Comprehensive Coding Capability Assessment                               ║", colors.cyan);
  log("╚══════════════════════════════════════════════════════════════════════════╝\n", colors.cyan);

  log(`Running ${benchmarks.length} benchmarks...\n`, colors.bright);

  for (const benchmark of benchmarks) {
    const diffColor = getDifficultyColor(benchmark.difficulty);

    if (options.verbose) {
      log(`\n─────────────────────────────────────────────────────────────`, colors.dim);
      log(`📋 ${benchmark.id}: ${benchmark.name}`, colors.bright);
      log(`   Category: ${benchmark.category} | Difficulty: ${diffColor}${benchmark.difficulty}${colors.reset}`);
      log(`   ${benchmark.description}`, colors.dim);
    } else {
      process.stdout.write(`  ${benchmark.id.padEnd(8)} ${benchmark.name.padEnd(35)} `);
    }

    // Execute benchmark
    const { output, tokensUsed, duration } = await executeBenchmark(benchmark, options);

    // Grade result
    const result = await grader.grade(benchmark, output, tokensUsed, duration);
    results.push(result);

    // Display result
    const scoreColor = getScoreColor(result.scores.overall);
    if (options.verbose) {
      log(`\n   Results:`, colors.bright);
      log(`     Correctness:    ${scoreColor}${result.scores.correctness.toString().padStart(3)}%${colors.reset}`);
      log(`     Code Quality:   ${scoreColor}${result.scores.codeQuality.toString().padStart(3)}%${colors.reset}`);
      log(`     Efficiency:     ${scoreColor}${result.scores.efficiency.toString().padStart(3)}%${colors.reset}`);
      log(`     Best Practices: ${scoreColor}${result.scores.bestPractices.toString().padStart(3)}%${colors.reset}`);
      log(`     Overall:        ${scoreColor}${result.scores.overall.toString().padStart(3)}%${colors.reset}`);
      log(`     Tokens:         ${result.tokens.actual} (expected: ${result.tokens.expected}, efficiency: ${(result.tokens.efficiency * 100).toFixed(1)}%)`);
      log(`     Duration:       ${duration}ms (limit: ${benchmark.timeLimit}ms)`);

      if (result.errors.length > 0) {
        log(`\n   Errors:`, colors.red);
        result.errors.forEach((e) => log(`     - ${e}`, colors.red));
      }
      if (result.warnings.length > 0) {
        log(`\n   Warnings:`, colors.yellow);
        result.warnings.forEach((w) => log(`     - ${w}`, colors.yellow));
      }
    } else {
      log(`${scoreColor}${result.scores.overall.toString().padStart(3)}%${colors.reset}`);
    }
  }

  // Calculate aggregated stats
  const categoryScores: Record<BenchmarkCategory, number> = {} as Record<BenchmarkCategory, number>;
  const difficultyScores: Record<Difficulty, number> = {} as Record<Difficulty, number>;

  const categoryCounts: Record<string, { sum: number; count: number }> = {};
  const difficultyCounts: Record<string, { sum: number; count: number }> = {};

  for (let i = 0; i < benchmarks.length; i++) {
    const benchmark = benchmarks[i];
    const result = results[i];

    // Category scores
    if (!categoryCounts[benchmark.category]) {
      categoryCounts[benchmark.category] = { sum: 0, count: 0 };
    }
    categoryCounts[benchmark.category].sum += result.scores.overall;
    categoryCounts[benchmark.category].count++;

    // Difficulty scores
    if (!difficultyCounts[benchmark.difficulty]) {
      difficultyCounts[benchmark.difficulty] = { sum: 0, count: 0 };
    }
    difficultyCounts[benchmark.difficulty].sum += result.scores.overall;
    difficultyCounts[benchmark.difficulty].count++;
  }

  for (const [category, { sum, count }] of Object.entries(categoryCounts)) {
    categoryScores[category as BenchmarkCategory] = Math.round(sum / count);
  }

  for (const [difficulty, { sum, count }] of Object.entries(difficultyCounts)) {
    difficultyScores[difficulty as Difficulty] = Math.round(sum / count);
  }

  const totalTokensUsed = results.reduce((sum, r) => sum + r.tokens.actual, 0);
  const totalTokensExpected = results.reduce((sum, r) => sum + r.tokens.expected, 0);
  const avgScore = results.reduce((sum, r) => sum + r.scores.overall, 0) / results.length;
  const passedCount = results.filter((r) => r.scores.overall >= 70).length;

  const suiteResult: BenchmarkSuiteResult = {
    suiteId: `suite_${Date.now()}`,
    timestamp: new Date().toISOString(),
    model: options.model || process.env.MODEL || "unknown",
    provider: options.provider || process.env.PROVIDER || "unknown",
    overallScore: Math.round(avgScore),
    categoryScores,
    difficultyScores,
    totalTokensUsed,
    totalTokensExpected,
    overallTokenEfficiency: totalTokensUsed > 0 ? totalTokensExpected / totalTokensUsed : 0,
    results,
    stats: {
      total: results.length,
      passed: passedCount,
      failed: results.length - passedCount,
      avgScore: Math.round(avgScore),
      avgTokenEfficiency: totalTokensUsed > 0 ? totalTokensExpected / totalTokensUsed : 0,
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

    case "terminal":
    default:
      outputTerminal(suiteResult);
      break;
  }
}

function outputTerminal(suiteResult: BenchmarkSuiteResult): void {
  log("\n╔══════════════════════════════════════════════════════════════════════════╗", colors.cyan);
  log("║  BENCHMARK RESULTS                                                        ║", colors.cyan);
  log("╠══════════════════════════════════════════════════════════════════════════╣", colors.cyan);

  const scoreColor = getScoreColor(suiteResult.overallScore);
  log(`║  Overall Score:        ${scoreColor}${suiteResult.overallScore.toString().padStart(3)}%${colors.reset}${" ".repeat(48)}║`, colors.cyan);
  log(`║  Passed:               ${suiteResult.stats.passed}/${suiteResult.stats.total}${" ".repeat(54)}║`, colors.cyan);
  log(`║  Token Efficiency:     ${(suiteResult.overallTokenEfficiency * 100).toFixed(1)}%${" ".repeat(50)}║`, colors.cyan);

  log("╠══════════════════════════════════════════════════════════════════════════╣", colors.cyan);
  log("║  Scores by Category:                                                      ║", colors.cyan);

  for (const [category, score] of Object.entries(suiteResult.categoryScores)) {
    const catColor = getScoreColor(score);
    log(`║    ${category.padEnd(25)} ${catColor}${score.toString().padStart(3)}%${colors.reset}${" ".repeat(42)}║`, colors.cyan);
  }

  log("╠══════════════════════════════════════════════════════════════════════════╣", colors.cyan);
  log("║  Scores by Difficulty:                                                    ║", colors.cyan);

  for (const [difficulty, score] of Object.entries(suiteResult.difficultyScores)) {
    const diffColor = getScoreColor(score);
    log(`║    ${difficulty.padEnd(25)} ${diffColor}${score.toString().padStart(3)}%${colors.reset}${" ".repeat(42)}║`, colors.cyan);
  }

  log("╚══════════════════════════════════════════════════════════════════════════╝\n", colors.cyan);

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

## Summary

| Metric | Value |
|--------|-------|
| Overall Score | ${suiteResult.overallScore}% |
| Passed | ${suiteResult.stats.passed}/${suiteResult.stats.total} |
| Token Efficiency | ${(suiteResult.overallTokenEfficiency * 100).toFixed(1)}% |

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
      } | ${r.scores.overall}% | ${r.tokens.actual} | ${r.timing.duration}ms |`
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
      log(`  ${b.id.padEnd(8)} ${b.name.padEnd(35)} ${diffColor}${b.difficulty.padEnd(8)}${colors.reset} ${b.expectedTokens} tokens`);
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
