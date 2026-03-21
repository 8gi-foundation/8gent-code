/**
 * 8gent Test Map
 *
 * Maps source files to their test files using naming conventions.
 * Convention-based: zero config, works with any standard test layout.
 */

import * as fs from "fs";
import * as path from "path";

const TEST_SUFFIXES = [".test.ts", ".test.tsx", ".test.js", ".spec.ts", ".spec.tsx", ".spec.js"];

/**
 * Given a source file path, return all test files that likely cover it.
 *
 * Checks three conventions:
 *   1. Sibling:    src/foo.ts  -> src/foo.test.ts
 *   2. __tests__:  src/foo.ts  -> src/__tests__/foo.test.ts
 *   3. Root tests: src/foo.ts  -> tests/foo.test.ts (rootDir/tests/)
 */
export function findTestsFor(filePath: string, rootDir: string): string[] {
  const absFile = path.resolve(filePath);
  const absRoot = path.resolve(rootDir);
  const dir = path.dirname(absFile);
  const base = path.basename(absFile).replace(/\.(ts|tsx|js|jsx)$/, "");
  const found: string[] = [];

  for (const suffix of TEST_SUFFIXES) {
    const candidate = path.join(dir, base + suffix);
    if (fs.existsSync(candidate)) found.push(candidate);
  }

  for (const suffix of TEST_SUFFIXES) {
    const candidate = path.join(dir, "__tests__", base + suffix);
    if (fs.existsSync(candidate)) found.push(candidate);
  }

  const relToRoot = path.relative(absRoot, absFile).replace(/\.(ts|tsx|js|jsx)$/, "");
  for (const testDir of ["tests", "test", "__tests__"]) {
    for (const suffix of TEST_SUFFIXES) {
      const candidate = path.join(absRoot, testDir, relToRoot + suffix);
      if (fs.existsSync(candidate)) found.push(candidate);
    }
  }

  return [...new Set(found)];
}

/**
 * Build a full source -> tests map for all files in the graph.
 */
export function buildTestMap(sourceFiles: string[], rootDir: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const file of sourceFiles) {
    const tests = findTestsFor(file, rootDir);
    if (tests.length > 0) map.set(file, tests);
  }
  return map;
}
