#!/usr/bin/env bun
/**
 * Test the TypeScript parser
 */

import { parseTypeScriptFile, getSymbolSource } from "./typescript-parser";

const testFile = process.argv[2] || "./typescript-parser.ts";

console.log(`Parsing: ${testFile}\n`);

try {
  const outline = parseTypeScriptFile(testFile);

  console.log(`File: ${outline.filePath}`);
  console.log(`Language: ${outline.language}`);
  console.log(`Symbols found: ${outline.symbols.length}\n`);

  for (const symbol of outline.symbols) {
    console.log(`─────────────────────────────`);
    console.log(`${symbol.kind}: ${symbol.name}`);
    console.log(`Lines: ${symbol.startLine}-${symbol.endLine}`);
    if (symbol.signature) {
      console.log(`Signature: ${symbol.signature}`);
    }
    if (symbol.docstring) {
      console.log(`Doc: ${symbol.docstring.slice(0, 100)}...`);
    }
  }

  console.log(`\n─────────────────────────────`);
  console.log(`Total: ${outline.symbols.length} symbols`);

  // Test getting source for first function
  const firstFunc = outline.symbols.find(s => s.kind === "function");
  if (firstFunc) {
    console.log(`\n─────────────────────────────`);
    console.log(`Source for ${firstFunc.name}:`);
    const source = getSymbolSource(outline.filePath, firstFunc.startLine, firstFunc.endLine);
    console.log(source.slice(0, 500) + "...");
  }
} catch (error) {
  console.error("Parse error:", error);
  process.exit(1);
}
