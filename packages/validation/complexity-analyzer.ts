/**
 * Cyclomatic Complexity Analyzer
 *
 * Measures cyclomatic complexity of TypeScript/JavaScript functions.
 * Flags functions exceeding a threshold (default: 10). Reports most complex files.
 *
 * Usage:
 *   bun run packages/validation/complexity-analyzer.ts [--threshold N] [--json] [--root path]
 */

import { Glob } from "bun";
import { readFileSync } from "fs";
import { resolve, relative } from "path";

export interface FunctionComplexity {
  name: string; file: string; line: number; complexity: number; flagged: boolean;
}

export interface FileComplexity {
  file: string; totalComplexity: number; maxComplexity: number; functions: FunctionComplexity[];
}

export interface ComplexityReport {
  scannedFiles: number; totalFunctions: number; flaggedFunctions: number;
  threshold: number; files: FileComplexity[]; flagged: FunctionComplexity[]; timestamp: string;
}

const IGNORE = /node_modules|\.git|dist|\.next|\.turbo|\.8gent/;
const BRANCHES = [
  /\bif\s*\(/g, /\belse\s+if\s*\(/g, /\bfor\s*\(/g, /\bwhile\s*\(/g,
  /\bcase\s+/g, /\bcatch\s*\(/g, /\?\?/g, /\?\./g, /&&/g, /\|\|/g, /\?[^?.]/g,
];

function collectFiles(root: string): string[] {
  const glob = new Glob("**/*.{ts,tsx,js,jsx}");
  const files: string[] = [];
  for (const p of glob.scanSync({ cwd: root })) {
    if (!IGNORE.test(p)) files.push(resolve(root, p));
  }
  return files;
}

function extractFunctions(content: string): { name: string; line: number; body: string }[] {
  const lines = content.split("\n");
  const results: { name: string; line: number; body: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(
      /(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\()/,
    );
    if (!m) continue;
    const name = m[1] || m[2];
    if (!name) continue;
    let braces = 0, started = false, body: string[] = [];
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === "{") { braces++; started = true; }
        if (ch === "}") braces--;
      }
      body.push(lines[j]);
      if (started && braces === 0) break;
    }
    results.push({ name, line: i + 1, body: body.join("\n") });
  }
  return results;
}

function measure(body: string): number {
  let c = 1;
  const clean = body
    .replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
  for (const pat of BRANCHES) {
    const hits = clean.match(new RegExp(pat.source, pat.flags));
    if (hits) c += hits.length;
  }
  return c;
}

export function analyzeComplexity(root: string, threshold = 10): ComplexityReport {
  const files = collectFiles(root);
  const fileResults: FileComplexity[] = [];
  const allFlagged: FunctionComplexity[] = [];
  let totalFunctions = 0;
  for (const file of files) {
    let content: string;
    try { content = readFileSync(file, "utf-8"); } catch { continue; }
    const fns = extractFunctions(content);
    if (!fns.length) continue;
    const rel = relative(root, file);
    const entries: FunctionComplexity[] = fns.map((fn) => {
      const complexity = measure(fn.body);
      const flagged = complexity > threshold;
      totalFunctions++;
      const entry = { name: fn.name, file: rel, line: fn.line, complexity, flagged };
      if (flagged) allFlagged.push(entry);
      return entry;
    });
    const total = entries.reduce((s, e) => s + e.complexity, 0);
    fileResults.push({ file: rel, totalComplexity: total, maxComplexity: Math.max(...entries.map((e) => e.complexity)), functions: entries });
  }
  fileResults.sort((a, b) => b.totalComplexity - a.totalComplexity);
  allFlagged.sort((a, b) => b.complexity - a.complexity);
  return { scannedFiles: files.length, totalFunctions, flaggedFunctions: allFlagged.length, threshold, files: fileResults, flagged: allFlagged, timestamp: new Date().toISOString() };
}

// CLI entrypoint
if (import.meta.main) {
  const a = process.argv;
  const root = a.includes("--root") ? resolve(a[a.indexOf("--root") + 1]) : resolve(import.meta.dir, "../..");
  const threshold = a.includes("--threshold") ? parseInt(a[a.indexOf("--threshold") + 1], 10) : 10;
  const json = a.includes("--json");
  console.log(`Analyzing complexity in ${root} (threshold: ${threshold})...\n`);
  const r = analyzeComplexity(root, threshold);
  if (json) { console.log(JSON.stringify(r, null, 2)); } else {
    console.log(`Files scanned: ${r.scannedFiles}`);
    console.log(`Total functions: ${r.totalFunctions}`);
    console.log(`Flagged (>${threshold}): ${r.flaggedFunctions}\n`);
    if (!r.flagged.length) { console.log("No functions exceed the complexity threshold."); } else {
      console.log("Flagged functions:\n");
      for (const fn of r.flagged) console.log(`  [${fn.complexity}] ${fn.name.padEnd(30)} ${fn.file}:${fn.line}`);
    }
    console.log("\nMost complex files (top 10):\n");
    for (const f of r.files.slice(0, 10)) console.log(`  [${f.totalComplexity}] ${f.file} (${f.functions.length} fns, max: ${f.maxComplexity})`);
  }
}
