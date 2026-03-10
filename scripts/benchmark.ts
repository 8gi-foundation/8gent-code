#!/usr/bin/env bun
/**
 * 8gent Code - Benchmark Suite
 *
 * Comprehensive benchmarks proving AST-first efficiency.
 * Run this before launch to validate claims.
 */

import * as fs from "fs";
import * as path from "path";
import { parseTypeScriptFile, getSymbolSource } from "../packages/ast-index/typescript-parser";
import { glob } from "glob";

interface BenchmarkResult {
  name: string;
  traditional: {
    tokens: number;
    time: number;
  };
  astFirst: {
    tokens: number;
    time: number;
  };
  savings: {
    tokens: number;
    percent: number;
    speedup: number;
  };
}

interface BenchmarkSuite {
  timestamp: string;
  results: BenchmarkResult[];
  summary: {
    totalTraditionalTokens: number;
    totalAstTokens: number;
    avgSavingsPercent: number;
    testsRun: number;
  };
}

const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
};

function log(msg: string, color: string = "") {
  console.log(`${color}${msg}${colors.reset}`);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

async function benchmarkSingleFile(filePath: string): Promise<BenchmarkResult> {
  const absolutePath = path.resolve(filePath);
  const name = path.relative(process.cwd(), absolutePath);

  // Traditional approach: read entire file
  const tradStart = performance.now();
  const content = fs.readFileSync(absolutePath, "utf-8");
  const tradTokens = estimateTokens(content);
  const tradTime = performance.now() - tradStart;

  // AST-first approach: outline + one symbol
  const astStart = performance.now();
  const outline = parseTypeScriptFile(absolutePath);
  const outlineJson = JSON.stringify(outline.symbols.map(s => ({
    name: s.name,
    kind: s.kind,
    lines: `${s.startLine}-${s.endLine}`,
    signature: s.signature?.slice(0, 60),
  })));

  // Get one symbol (simulating typical usage)
  let symbolTokens = 0;
  const targetSymbol = outline.symbols.find(s => s.kind === "function" && s.name.length > 3);
  if (targetSymbol) {
    const symbolSource = getSymbolSource(absolutePath, targetSymbol.startLine, targetSymbol.endLine);
    symbolTokens = estimateTokens(symbolSource);
  }

  const astTokens = estimateTokens(outlineJson) + symbolTokens;
  const astTime = performance.now() - astStart;

  const savedTokens = tradTokens - astTokens;
  const savingsPercent = tradTokens > 0 ? (savedTokens / tradTokens) * 100 : 0;

  return {
    name,
    traditional: { tokens: tradTokens, time: tradTime },
    astFirst: { tokens: astTokens, time: astTime },
    savings: {
      tokens: savedTokens,
      percent: savingsPercent,
      speedup: tradTime > 0 ? astTime / tradTime : 1,
    },
  };
}

async function benchmarkDirectory(directory: string, pattern: string = "**/*.{ts,tsx}"): Promise<BenchmarkResult[]> {
  const files = await glob(pattern, {
    cwd: directory,
    absolute: true,
    ignore: ["**/node_modules/**", "**/dist/**", "**/*.d.ts"],
  });

  const results: BenchmarkResult[] = [];
  for (const file of files.slice(0, 20)) { // Limit to 20 files
    try {
      const result = await benchmarkSingleFile(file);
      results.push(result);
    } catch (e) {
      // Skip files that can't be parsed
    }
  }

  return results;
}

async function runFullBenchmark(): Promise<BenchmarkSuite> {
  log("\n╔══════════════════════════════════════════════════════════════╗", colors.cyan);
  log("║  8gent Code - Benchmark Suite                                 ║", colors.cyan);
  log("║  Proving AST-first efficiency at scale                        ║", colors.cyan);
  log("╚══════════════════════════════════════════════════════════════╝\n", colors.cyan);

  const results: BenchmarkResult[] = [];

  // Benchmark: 8gent's own codebase
  log("📊 Benchmark 1: 8gent Code's own codebase", colors.bright);
  const selfResults = await benchmarkDirectory(process.cwd());
  results.push(...selfResults);

  // Print individual results
  for (const r of selfResults) {
    const emoji = r.savings.percent > 50 ? "🔥" : r.savings.percent > 30 ? "✨" : "📄";
    log(`  ${emoji} ${r.name.padEnd(40)} ${r.savings.percent.toFixed(1).padStart(5)}% saved (${r.savings.tokens.toLocaleString()} tokens)`);
  }

  // Calculate summary
  const totalTraditional = results.reduce((sum, r) => sum + r.traditional.tokens, 0);
  const totalAst = results.reduce((sum, r) => sum + r.astFirst.tokens, 0);
  const avgSavings = results.length > 0
    ? results.reduce((sum, r) => sum + r.savings.percent, 0) / results.length
    : 0;

  const suite: BenchmarkSuite = {
    timestamp: new Date().toISOString(),
    results,
    summary: {
      totalTraditionalTokens: totalTraditional,
      totalAstTokens: totalAst,
      avgSavingsPercent: avgSavings,
      testsRun: results.length,
    },
  };

  // Print summary
  log("\n╔══════════════════════════════════════════════════════════════╗", colors.green);
  log("║  BENCHMARK RESULTS                                            ║", colors.green);
  log("╠══════════════════════════════════════════════════════════════╣", colors.green);
  log(`║  Files benchmarked:         ${suite.summary.testsRun.toString().padStart(10)}                    ║`, colors.green);
  log(`║  Traditional tokens:    ${totalTraditional.toLocaleString().padStart(14)}                    ║`, colors.green);
  log(`║  AST-first tokens:      ${totalAst.toLocaleString().padStart(14)}                    ║`, colors.green);
  log(`║  Total tokens saved:    ${(totalTraditional - totalAst).toLocaleString().padStart(14)}                    ║`, colors.green);
  log(`║  Average savings:       ${avgSavings.toFixed(1).padStart(13)}%                    ║`, colors.green);
  log("╚══════════════════════════════════════════════════════════════╝\n", colors.green);

  // Cost savings projection
  log("💰 Cost savings projection (per 10,000 operations):\n", colors.yellow);
  const savedTokensK = ((totalTraditional - totalAst) * 10000) / 1000;

  const providers = [
    { name: "Claude Opus 4.5", rate: 15 },
    { name: "Claude Sonnet 4.6", rate: 3 },
    { name: "GPT-5", rate: 10 },
    { name: "Gemini 2.0", rate: 7 },
  ];

  for (const p of providers) {
    const cost = (savedTokensK * p.rate) / 1000;
    log(`   ${p.name.padEnd(18)} $${cost.toFixed(2)} saved`);
  }

  log("\n🚀 These savings compound across every codebase interaction.", colors.bright);
  log("   This is why 8gent Code users never hit usage caps.\n");

  // Save results to file
  const resultsPath = path.join(process.cwd(), "benchmark-results.json");
  fs.writeFileSync(resultsPath, JSON.stringify(suite, null, 2));
  log(`📄 Full results saved to: ${resultsPath}`, colors.cyan);

  return suite;
}

// Specific symbol retrieval benchmark
async function benchmarkSymbolRetrieval(): Promise<void> {
  log("\n🎯 Benchmark: Symbol Retrieval Efficiency\n", colors.bright);

  const testFile = path.join(process.cwd(), "packages/ast-index/typescript-parser.ts");
  if (!fs.existsSync(testFile)) {
    log("   Test file not found, skipping...", colors.yellow);
    return;
  }

  const content = fs.readFileSync(testFile, "utf-8");
  const fullFileTokens = estimateTokens(content);

  log(`   Full file: ${fullFileTokens.toLocaleString()} tokens`);

  // Parse and get specific symbols
  const outline = parseTypeScriptFile(testFile);
  const symbols = ["parseTypeScriptFile", "extractSymbol", "getJsDoc", "buildSymbolId"];

  for (const symbolName of symbols) {
    const symbol = outline.symbols.find(s => s.name === symbolName);
    if (symbol) {
      const source = getSymbolSource(testFile, symbol.startLine, symbol.endLine);
      const symbolTokens = estimateTokens(source);
      const savings = ((fullFileTokens - symbolTokens) / fullFileTokens * 100).toFixed(1);
      log(`   ${symbolName.padEnd(25)} ${symbolTokens.toLocaleString().padStart(6)} tokens (${savings}% less than full file)`);
    }
  }
}

// Run benchmarks
async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--symbols")) {
    await benchmarkSymbolRetrieval();
  } else if (args.includes("--quick")) {
    // Quick single-file benchmark
    const testFile = args[args.indexOf("--quick") + 1] ||
      path.join(process.cwd(), "packages/ast-index/typescript-parser.ts");
    const result = await benchmarkSingleFile(testFile);
    log(`\n📄 ${result.name}`);
    log(`   Traditional: ${result.traditional.tokens.toLocaleString()} tokens`);
    log(`   AST-first:   ${result.astFirst.tokens.toLocaleString()} tokens`);
    log(`   Saved:       ${result.savings.tokens.toLocaleString()} tokens (${result.savings.percent.toFixed(1)}%)`);
  } else {
    await runFullBenchmark();
    await benchmarkSymbolRetrieval();
  }
}

main().catch(console.error);
