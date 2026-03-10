#!/usr/bin/env bun
/**
 * 8gent Code - Token Savings Demo
 *
 * Demonstrates the dramatic token reduction of AST-first vs traditional approach.
 * Perfect for README gifs and viral demos.
 */

import * as fs from "fs";
import * as path from "path";
import { parseTypeScriptFile, getSymbolSource } from "../packages/ast-index/typescript-parser";

const DEMO_FILE = process.argv[2] || path.join(__dirname, "../packages/ast-index/typescript-parser.ts");

console.log("╔══════════════════════════════════════════════════════════════╗");
console.log("║  8gent Code - Token Savings Demo                             ║");
console.log("║  \"Never hit usage caps again\"                                ║");
console.log("╚══════════════════════════════════════════════════════════════╝\n");

// Get file info
const fileContent = fs.readFileSync(DEMO_FILE, "utf-8");
const fileSize = fileContent.length;
const fullFileTokens = Math.ceil(fileSize / 4);

console.log(`📄 File: ${path.basename(DEMO_FILE)}`);
console.log(`   Size: ${fileSize.toLocaleString()} bytes`);
console.log(`   Traditional approach: ~${fullFileTokens.toLocaleString()} tokens\n`);

// Parse with AST
console.log("🔍 AST-first approach:\n");

const outline = parseTypeScriptFile(DEMO_FILE);
const outlineJson = JSON.stringify(outline.symbols.map(s => ({
  name: s.name,
  kind: s.kind,
  lines: `${s.startLine}-${s.endLine}`,
  signature: s.signature?.slice(0, 50),
})), null, 2);

const outlineTokens = Math.ceil(outlineJson.length / 4);

console.log(`   Step 1: get_outline()`);
console.log(`   → ${outline.symbols.length} symbols found`);
console.log(`   → ~${outlineTokens.toLocaleString()} tokens\n`);

// Show some symbols
console.log("   Symbols found:");
for (const symbol of outline.symbols.slice(0, 8)) {
  console.log(`   • ${symbol.kind.padEnd(10)} ${symbol.name}`);
}
if (outline.symbols.length > 8) {
  console.log(`   ... and ${outline.symbols.length - 8} more\n`);
} else {
  console.log("");
}

// Get a specific symbol
const targetSymbol = outline.symbols.find(s => s.kind === "function" && s.name.length > 5);
if (targetSymbol) {
  const symbolSource = getSymbolSource(DEMO_FILE, targetSymbol.startLine, targetSymbol.endLine);
  const symbolTokens = Math.ceil(symbolSource.length / 4);

  console.log(`   Step 2: get_symbol("${targetSymbol.name}")`);
  console.log(`   → Lines ${targetSymbol.startLine}-${targetSymbol.endLine}`);
  console.log(`   → ~${symbolTokens.toLocaleString()} tokens\n`);

  const totalAstTokens = outlineTokens + symbolTokens;
  const savings = fullFileTokens - totalAstTokens;
  const savingsPercent = ((savings / fullFileTokens) * 100).toFixed(1);

  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  RESULTS                                                      ║");
  console.log("╠══════════════════════════════════════════════════════════════╣");
  console.log(`║  Traditional (full read):     ${fullFileTokens.toLocaleString().padStart(8)} tokens            ║`);
  console.log(`║  AST-first (outline+symbol):  ${totalAstTokens.toLocaleString().padStart(8)} tokens            ║`);
  console.log(`║                               ─────────                       ║`);
  console.log(`║  TOKENS SAVED:                ${savings.toLocaleString().padStart(8)} (${savingsPercent}%)          ║`);
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  // Cost savings at different rates
  console.log("💰 Cost savings per 1000 similar operations:\n");
  const ops = 1000;
  const savedTokensK = (savings * ops) / 1000;

  const rates = [
    { name: "Claude Opus 4.5", input: 15, output: 75 },
    { name: "Claude Sonnet 4.6", input: 3, output: 15 },
    { name: "GPT-5", input: 10, output: 30 },
  ];

  for (const rate of rates) {
    const cost = (savedTokensK * rate.input) / 1000;
    console.log(`   ${rate.name.padEnd(18)} $${cost.toFixed(2)} saved`);
  }

  console.log("\n🚀 Scale this across a full development session and the savings are massive.");
  console.log("   This is why 8gent Code users never hit usage caps.\n");
}
