/**
 * Codebase Health Monitor
 *
 * Scans the 8gent-code monorepo and produces a 0-100 health score based on:
 *   1. Code debt markers (TODO/FIXME/HACK density)
 *   2. Test coverage (source files that have a matching test file)
 *   3. Dependency hygiene (unused / extraneous deps in package.json)
 *   4. Lines-of-code breakdown by language
 *
 * Usage:
 *   bun run packages/proactive/health-monitor.ts           # print report
 *   bun run packages/proactive/health-monitor.ts --json    # machine-readable
 *
 * Designed to run in CI or a daily cron without external dependencies.
 */

import { readdir, stat, readFile } from "node:fs/promises";
import { join, extname, basename, relative } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SCAN_DIRS = ["packages", "apps", "src", "scripts", "benchmarks"];
const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", ".turbo", ".next", ".8gent"]);
const CODE_EXTS: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript (JSX)",
  ".js": "JavaScript",
  ".jsx": "JavaScript (JSX)",
  ".json": "JSON",
  ".css": "CSS",
  ".html": "HTML",
  ".yaml": "YAML",
  ".yml": "YAML",
  ".sh": "Shell",
  ".md": "Markdown",
};
const DEBT_PATTERN = /\b(TODO|FIXME|HACK|XXX|WORKAROUND)\b/gi;
const TEST_PATTERN = /\.(test|spec)\.(ts|tsx|js|jsx)$/;
const SOURCE_PATTERN = /\.(ts|tsx|js|jsx)$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HealthReport {
  timestamp: string;
  score: number;
  breakdown: {
    debtScore: number;
    testScore: number;
    depScore: number;
  };
  loc: Record<string, number>;
  totalFiles: number;
  totalLines: number;
  debt: { total: number; byType: Record<string, number>; density: string };
  tests: { sourceFiles: number; testFiles: number; coveragePercent: number; uncovered: string[] };
  deps: { total: number; likelyUnused: string[]; unusedCount: number };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function walk(dir: string, files: string[] = []): Promise<string[]> {
  let entries: Awaited<ReturnType<typeof readdir>> = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const e of entries) {
    if (IGNORE_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      await walk(full, files);
    } else {
      files.push(full);
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Scanners
// ---------------------------------------------------------------------------

async function scanLOC(files: string[], root: string): Promise<{ loc: Record<string, number>; totalLines: number }> {
  const loc: Record<string, number> = {};
  let totalLines = 0;
  for (const f of files) {
    const ext = extname(f);
    const lang = CODE_EXTS[ext];
    if (!lang) continue;
    try {
      const content = await readFile(f, "utf-8");
      const lines = content.split("\n").length;
      loc[lang] = (loc[lang] || 0) + lines;
      totalLines += lines;
    } catch { /* skip unreadable */ }
  }
  return { loc, totalLines };
}

async function scanDebt(files: string[]): Promise<{ total: number; byType: Record<string, number> }> {
  const byType: Record<string, number> = {};
  let total = 0;
  for (const f of files) {
    const ext = extname(f);
    if (!SOURCE_PATTERN.test(f) && ext !== ".ts") continue;
    try {
      const content = await readFile(f, "utf-8");
      const matches = content.match(DEBT_PATTERN);
      if (matches) {
        total += matches.length;
        for (const m of matches) {
          const key = m.toUpperCase();
          byType[key] = (byType[key] || 0) + 1;
        }
      }
    } catch { /* skip */ }
  }
  return { total, byType };
}

function scanTestCoverage(files: string[], root: string): { sourceFiles: number; testFiles: number; coveragePercent: number; uncovered: string[] } {
  const sourceSet = new Set<string>();
  const testSet = new Set<string>();

  for (const f of files) {
    const rel = relative(root, f);
    if (TEST_PATTERN.test(f)) {
      // Derive the source file this test covers
      const base = basename(f).replace(/\.(test|spec)\./, ".");
      testSet.add(base);
    } else if (SOURCE_PATTERN.test(f) && !f.includes("node_modules")) {
      sourceSet.add(rel);
    }
  }

  const uncovered: string[] = [];
  for (const src of sourceSet) {
    const base = basename(src);
    if (!testSet.has(base)) {
      uncovered.push(src);
    }
  }

  const sourceFiles = sourceSet.size;
  const testFiles = testSet.size;
  const covered = sourceFiles - uncovered.length;
  const coveragePercent = sourceFiles > 0 ? Math.round((covered / sourceFiles) * 100) : 100;

  // Only return first 20 uncovered for readability
  return { sourceFiles, testFiles, coveragePercent, uncovered: uncovered.slice(0, 20) };
}

async function scanDeps(root: string): Promise<{ total: number; likelyUnused: string[]; unusedCount: number }> {
  let pkg: any;
  try {
    const raw = await readFile(join(root, "package.json"), "utf-8");
    pkg = JSON.parse(raw);
  } catch {
    return { total: 0, likelyUnused: [], unusedCount: 0 };
  }

  const allDeps = Object.keys(pkg.dependencies || {});
  const total = allDeps.length;

  // Quick heuristic: grep all source files for import/require of each dep
  const files = await walk(root);
  const sourceFiles = files.filter(f => SOURCE_PATTERN.test(f));
  const allSource = await Promise.all(
    sourceFiles.slice(0, 500).map(async f => {
      try { return await readFile(f, "utf-8"); } catch { return ""; }
    })
  );
  const merged = allSource.join("\n");

  const likelyUnused: string[] = [];
  for (const dep of allDeps) {
    // Check if the dep name appears in any import/require
    const depName = dep.startsWith("@") ? dep : dep.split("/")[0];
    if (!merged.includes(depName)) {
      likelyUnused.push(dep);
    }
  }

  return { total, likelyUnused, unusedCount: likelyUnused.length };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function computeScore(debt: { total: number }, totalLines: number, testCoverage: number, unusedDeps: number, totalDeps: number): { score: number; debtScore: number; testScore: number; depScore: number } {
  // Debt score (40 points max) - lower debt density = higher score
  const density = totalLines > 0 ? debt.total / (totalLines / 1000) : 0;
  // 0 markers per 1k lines = 40pts, 10+ per 1k = 0pts
  const debtScore = Math.max(0, Math.round(40 * (1 - Math.min(density / 10, 1))));

  // Test score (35 points max) - higher coverage = higher score
  const testScore = Math.round(35 * (testCoverage / 100));

  // Dependency score (25 points max) - fewer unused = higher score
  const usedRatio = totalDeps > 0 ? (totalDeps - unusedDeps) / totalDeps : 1;
  const depScore = Math.round(25 * usedRatio);

  const score = debtScore + testScore + depScore;
  return { score, debtScore, testScore, depScore };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runHealthCheck(rootDir: string): Promise<HealthReport> {
  const files = await walk(rootDir);
  const { loc, totalLines } = await scanLOC(files, rootDir);
  const debt = await scanDebt(files);
  const tests = scanTestCoverage(files, rootDir);
  const deps = await scanDeps(rootDir);
  const { score, debtScore, testScore, depScore } = computeScore(debt, totalLines, tests.coveragePercent, deps.unusedCount, deps.total);
  const density = totalLines > 0 ? (debt.total / (totalLines / 1000)).toFixed(2) : "0";

  return {
    timestamp: new Date().toISOString(),
    score,
    breakdown: { debtScore, testScore, depScore },
    loc,
    totalFiles: files.length,
    totalLines,
    debt: { ...debt, density: `${density} per 1k lines` },
    tests,
    deps,
  };
}

function formatReport(r: HealthReport): string {
  const grade = r.score >= 80 ? "A" : r.score >= 60 ? "B" : r.score >= 40 ? "C" : r.score >= 20 ? "D" : "F";
  const lines = [
    `\n  8gent Codebase Health Report`,
    `  ${"=".repeat(40)}`,
    `  Score: ${r.score}/100 (${grade})`,
    `  Generated: ${r.timestamp}`,
    ``,
    `  Breakdown:`,
    `    Code debt:    ${r.breakdown.debtScore}/40`,
    `    Test coverage: ${r.breakdown.testScore}/35`,
    `    Dependencies:  ${r.breakdown.depScore}/25`,
    ``,
    `  Lines of Code (${r.totalFiles} files, ${r.totalLines.toLocaleString()} lines):`,
    ...Object.entries(r.loc)
      .sort(([, a], [, b]) => b - a)
      .map(([lang, count]) => `    ${lang.padEnd(20)} ${count.toLocaleString()}`),
    ``,
    `  Debt Markers (${r.debt.total} total, ${r.debt.density}):`,
    ...Object.entries(r.debt.byType).map(([type, count]) => `    ${type}: ${count}`),
    ``,
    `  Test Coverage: ${r.tests.coveragePercent}% (${r.tests.testFiles} test files for ${r.tests.sourceFiles} source files)`,
    ...(r.tests.uncovered.length > 0 ? [`  Uncovered (first 20):`, ...r.tests.uncovered.map(f => `    - ${f}`)] : []),
    ``,
    `  Dependencies: ${r.deps.total} total, ${r.deps.unusedCount} possibly unused`,
    ...(r.deps.likelyUnused.length > 0 ? [`  Possibly unused:`, ...r.deps.likelyUnused.map(d => `    - ${d}`)] : []),
    ``,
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const root = process.cwd();
  const jsonMode = process.argv.includes("--json");
  const report = await runHealthCheck(root);

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report));
  }

  // Exit with non-zero if score is critically low (useful for CI)
  if (report.score < 20) {
    process.exit(1);
  }
}
