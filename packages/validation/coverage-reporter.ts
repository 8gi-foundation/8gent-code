/**
 * Coverage Reporter - analyzes which source files have corresponding test files.
 * Calculates coverage percentage per package and generates a gap report.
 *
 * Usage:
 *   bun run packages/validation/coverage-reporter.ts [--json] [packagesDir]
 */

import { readdirSync, statSync, existsSync } from "fs";
import { join, basename, relative } from "path";

export interface PackageCoverage {
  name: string;
  sourceFiles: string[];
  testedFiles: string[];
  untestedFiles: string[];
  coveragePercent: number;
}

export interface CoverageReport {
  generated: string;
  totalSourceFiles: number;
  totalTestedFiles: number;
  overallCoveragePercent: number;
  packages: PackageCoverage[];
}

const TEST_SUFFIXES = [".test.ts", ".spec.ts", ".test.tsx", ".spec.tsx"];
const IGNORE_FILES = ["index.ts", "types.ts"];

function isSourceFile(name: string): boolean {
  if (name.endsWith(".d.ts")) return false;
  if (TEST_SUFFIXES.some((s) => name.endsWith(s))) return false;
  if (!name.endsWith(".ts") && !name.endsWith(".tsx")) return false;
  return true;
}

function collectFiles(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(full));
    } else {
      results.push(full);
    }
  }
  return results;
}

function testFileExists(srcPath: string, allFiles: Set<string>): boolean {
  const base = srcPath.replace(/\.tsx?$/, "");
  return TEST_SUFFIXES.some((s) => allFiles.has(base + s));
}

export function analyzePackages(packagesDir: string): CoverageReport {
  const pkgNames = readdirSync(packagesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "node_modules")
    .map((d) => d.name)
    .sort();

  const packages: PackageCoverage[] = [];

  for (const pkg of pkgNames) {
    const pkgDir = join(packagesDir, pkg);
    const allFiles = collectFiles(pkgDir);
    const allFileSet = new Set(allFiles);

    const sourceFiles = allFiles
      .filter((f) => isSourceFile(basename(f)))
      .filter((f) => !IGNORE_FILES.includes(basename(f)))
      .map((f) => relative(packagesDir, f));

    const testedFiles = sourceFiles.filter((f) =>
      testFileExists(join(packagesDir, f), allFileSet)
    );
    const untestedFiles = sourceFiles.filter(
      (f) => !testedFiles.includes(f)
    );

    const coveragePercent =
      sourceFiles.length === 0
        ? 100
        : Math.round((testedFiles.length / sourceFiles.length) * 100);

    packages.push({
      name: pkg,
      sourceFiles,
      testedFiles,
      untestedFiles,
      coveragePercent,
    });
  }

  const totalSource = packages.reduce((s, p) => s + p.sourceFiles.length, 0);
  const totalTested = packages.reduce((s, p) => s + p.testedFiles.length, 0);

  return {
    generated: new Date().toISOString().slice(0, 10),
    totalSourceFiles: totalSource,
    totalTestedFiles: totalTested,
    overallCoveragePercent:
      totalSource === 0 ? 100 : Math.round((totalTested / totalSource) * 100),
    packages,
  };
}

// CLI entry point
if (import.meta.main) {
  const args = process.argv.slice(2);
  const jsonMode = args.includes("--json");
  const dir = args.find((a) => !a.startsWith("--")) ?? join(import.meta.dir, "..", "..");
  const packagesDir = join(dir, "packages");

  const report = analyzePackages(packagesDir);

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Coverage Report - ${report.generated}`);
    console.log(`Overall: ${report.totalTestedFiles}/${report.totalSourceFiles} files tested (${report.overallCoveragePercent}%)\n`);
    for (const pkg of report.packages) {
      if (pkg.sourceFiles.length === 0) continue;
      const bar = pkg.coveragePercent === 100 ? "FULL" : `${pkg.coveragePercent}%`;
      console.log(`  ${pkg.name.padEnd(20)} ${bar.padStart(5)}  (${pkg.testedFiles.length}/${pkg.sourceFiles.length})`);
    }
  }
}
