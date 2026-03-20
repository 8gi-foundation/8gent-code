/**
 * 8gent Blast Radius Engine
 *
 * Before editing a file, compute what else could break:
 * direct dependents, transitive dependents, and affected test files.
 *
 * Inspired by the Blast Radius Engine concept — rebuilt from scratch in <200 lines.
 */

import * as path from "path";
import { buildDepGraph, type DepGraph } from "./dep-graph";
import { findTestsFor } from "./test-map";

export interface BlastRadius {
  filePath: string;
  directDependents: string[];     // Files that directly import this file
  transitiveDependents: string[]; // Files that import those, recursively
  affectedTests: string[];        // Test files covering this code and its dependents
  impact: "low" | "medium" | "high";
  summary: string;
}

// In-memory cache — rebuild on explicit invalidation
let cachedGraph: DepGraph | null = null;
let cachedRoot: string | null = null;

/** Get or build the dep graph (cached per rootDir) */
function getGraph(rootDir: string): DepGraph {
  const absRoot = path.resolve(rootDir);
  if (cachedGraph && cachedRoot === absRoot) return cachedGraph;
  cachedGraph = buildDepGraph(absRoot);
  cachedRoot = absRoot;
  return cachedGraph;
}

/** Invalidate the in-memory graph cache (call after file changes) */
export function invalidateGraphCache(): void {
  cachedGraph = null;
  cachedRoot = null;
}

/**
 * Walk the reverse-dependency graph transitively from a set of seed files.
 * Returns all files reachable via "exportedBy" edges, excluding the seeds.
 */
function collectTransitive(seeds: string[], graph: DepGraph): string[] {
  const visited = new Set<string>(seeds);
  const queue = [...seeds];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const node = graph.nodes.get(current);
    if (!node) continue;
    for (const dependent of node.exportedBy) {
      if (!visited.has(dependent)) {
        visited.add(dependent);
        queue.push(dependent);
      }
    }
  }

  // Remove seeds - we only want dependents
  for (const seed of seeds) visited.delete(seed);
  return [...visited];
}

/**
 * Compute the blast radius of changing a single file.
 *
 * @param filePath  Absolute or relative path to the file being changed
 * @param rootDir   Project root (used to build/retrieve the dep graph)
 */
export function getBlastRadius(filePath: string, rootDir: string): BlastRadius {
  const absFile = path.resolve(filePath);
  const graph = getGraph(rootDir);

  const node = graph.nodes.get(absFile);
  const directDependents = node ? [...node.exportedBy] : [];

  const transitiveDependents = collectTransitive([absFile, ...directDependents], graph).filter(
    f => !directDependents.includes(f)
  );

  // Gather tests for the changed file + all its dependents
  const allAffected = [absFile, ...directDependents, ...transitiveDependents];
  const testSet = new Set<string>();
  for (const f of allAffected) {
    for (const t of findTestsFor(f, rootDir)) {
      testSet.add(t);
    }
  }
  const affectedTests = [...testSet];

  // Impact classification: count distinct affected files (excluding self)
  const totalAffected = directDependents.length + transitiveDependents.length;
  const impact: BlastRadius["impact"] =
    totalAffected === 0 ? "low" :
    totalAffected <= 4  ? "medium" : "high";

  const rel = (f: string) => path.relative(rootDir, f);
  const fileLabel = rel(absFile);
  const testLabel = affectedTests.length === 1 ? "1 test suite" : `${affectedTests.length} test suites`;
  const depLabel = totalAffected === 1 ? "1 file" : `${totalAffected} files`;

  const summary = totalAffected === 0
    ? `Changing ${fileLabel} affects no other tracked files.`
    : `Changing ${fileLabel} affects ${depLabel} and ${testLabel}.`;

  return {
    filePath: absFile,
    directDependents,
    transitiveDependents,
    affectedTests,
    impact,
    summary,
  };
}

/**
 * Convenience: build the dep graph explicitly and return it.
 * Useful when you want the graph for multiple blast-radius calls.
 */
export { buildDepGraph, type DepGraph } from "./dep-graph";
export { findTestsFor, buildTestMap } from "./test-map";
