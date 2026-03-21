/**
 * 8gent Blast Radius Engine
 *
 * Before editing a file, compute what else could break:
 * direct dependents, transitive dependents, and affected test files.
 *
 * Inspired by the Blast Radius Engine concept — rebuilt from scratch.
 */

import * as path from "path";
import { buildDepGraph, type DepGraph } from "./dep-graph";
import { findTestsFor } from "./test-map";

export interface BlastRadius {
  filePath: string;
  directDependents: string[];
  transitiveDependents: string[];
  affectedTests: string[];
  impact: "low" | "medium" | "high";
  summary: string;
}

let cachedGraph: DepGraph | null = null;
let cachedRoot: string | null = null;

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

function collectTransitive(seeds: string[], graph: DepGraph): string[] {
  const visited = new Set<string>(seeds);
  const queue = [...seeds];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const node = graph.nodes.get(current);
    if (!node) continue;
    for (const dep of node.exportedBy) {
      if (!visited.has(dep)) { visited.add(dep); queue.push(dep); }
    }
  }
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

  const transitiveDependents = collectTransitive([absFile, ...directDependents], graph)
    .filter(f => !directDependents.includes(f));

  const allAffected = [absFile, ...directDependents, ...transitiveDependents];
  const testSet = new Set<string>();
  for (const f of allAffected) {
    for (const t of findTestsFor(f, rootDir)) testSet.add(t);
  }
  const affectedTests = [...testSet];

  const totalAffected = directDependents.length + transitiveDependents.length;
  const impact: BlastRadius["impact"] =
    totalAffected === 0 ? "low" : totalAffected <= 4 ? "medium" : "high";

  const rel = (f: string) => path.relative(rootDir, f);
  const fileLabel = rel(absFile);
  const testLabel = affectedTests.length === 1 ? "1 test suite" : `${affectedTests.length} test suites`;
  const depLabel = totalAffected === 1 ? "1 file" : `${totalAffected} files`;

  const summary = totalAffected === 0
    ? `Changing ${fileLabel} affects no other tracked files.`
    : `Changing ${fileLabel} affects ${depLabel} and ${testLabel}.`;

  return { filePath: absFile, directDependents, transitiveDependents, affectedTests, impact, summary };
}

export { buildDepGraph, type DepGraph } from "./dep-graph";
export { findTestsFor, buildTestMap } from "./test-map";
