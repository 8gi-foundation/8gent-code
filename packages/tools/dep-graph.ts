/**
 * packages/tools/dep-graph.ts
 *
 * Monorepo internal dependency graph scanner.
 * Scans package.json files, builds internal dep graph, detects cycles, outputs DOT.
 * Zero external deps - uses Bun built-ins only.
 *
 * Exports: buildGraph(), detectCycles()
 * CLI: bun packages/tools/dep-graph.ts [--dot] [--cycles] [--root <path>]
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

// -------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------

export interface PackageNode {
  name: string;
  path: string; // absolute path to package.json
  deps: string[]; // internal dep names only
}

export interface DepGraph {
  nodes: Map<string, PackageNode>; // name -> node
  edges: Map<string, string[]>; // name -> [dep names]
}

export interface Cycle {
  path: string[]; // ordered list of package names forming the cycle
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

const EXCLUDED_DIRS = new Set(["node_modules", ".next", ".git", "dist", "build"]);

function isInternalDep(name: string): boolean {
  return name.startsWith("@8gent/") || name.startsWith("@podjamz/");
}

function findPackageJsonFiles(root: string): string[] {
  const results: string[] = [];

  function walk(dir: string) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (EXCLUDED_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full);
      } else if (entry === "package.json") {
        results.push(full);
      }
    }
  }

  walk(root);
  return results;
}

function parsePackageJson(filePath: string): PackageNode | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return null;
  }

  const name = typeof pkg.name === "string" ? pkg.name.trim() : "";
  if (!name) return null;

  const allDeps: string[] = [
    ...Object.keys((pkg.dependencies as Record<string, string>) ?? {}),
    ...Object.keys((pkg.devDependencies as Record<string, string>) ?? {}),
    ...Object.keys((pkg.peerDependencies as Record<string, string>) ?? {}),
  ];

  const deps = allDeps.filter(isInternalDep);

  return { name, path: filePath, deps };
}

// -------------------------------------------------------------------------
// Core exports
// -------------------------------------------------------------------------

/**
 * Scans the monorepo rooted at `root` and returns an internal dependency graph.
 * Only @8gent/* and @podjamz/* packages are included as nodes/edges.
 */
export function buildGraph(root: string = process.cwd()): DepGraph {
  const files = findPackageJsonFiles(root);
  const nodes = new Map<string, PackageNode>();

  for (const file of files) {
    const node = parsePackageJson(file);
    if (!node) continue;
    // Include workspace packages (apps/ and packages/) plus any named @8gent/@podjamz package
    const isWorkspacePkg =
      file.includes("/apps/") ||
      file.includes("/packages/") ||
      isInternalDep(node.name) ||
      node.name === "@podjamz/8gent-code";
    if (!isWorkspacePkg) continue;
    nodes.set(node.name, node);
  }

  // Build edge map - only include edges where the dep is a known node
  const edges = new Map<string, string[]>();
  for (const [name, node] of nodes) {
    const resolved = node.deps.filter((d) => nodes.has(d));
    edges.set(name, resolved);
  }

  return { nodes, edges };
}

/**
 * Detects cycles in the dependency graph using DFS.
 * Returns an array of cycles, each as an ordered list of package names.
 * An empty array means no cycles (a DAG).
 */
export function detectCycles(graph: DepGraph): Cycle[] {
  const cycles: Cycle[] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const stackPath: string[] = [];

  function dfs(node: string) {
    if (inStack.has(node)) {
      // Found a cycle - extract it from stackPath
      const cycleStart = stackPath.indexOf(node);
      const cyclePath = [...stackPath.slice(cycleStart), node];
      // Normalise: start from lexicographically smallest node
      const minIdx = cyclePath.slice(0, -1).reduce((mi, n, i) => (n < cyclePath[mi] ? i : mi), 0);
      const normalised = [
        ...cyclePath.slice(minIdx, cyclePath.length - 1),
        ...cyclePath.slice(0, minIdx),
        cyclePath[minIdx], // close the loop
      ];
      cycles.push({ path: normalised });
      return;
    }
    if (visited.has(node)) return;

    visited.add(node);
    inStack.add(node);
    stackPath.push(node);

    for (const dep of graph.edges.get(node) ?? []) {
      dfs(dep);
    }

    stackPath.pop();
    inStack.delete(node);
  }

  for (const name of graph.nodes.keys()) {
    if (!visited.has(name)) {
      dfs(name);
    }
  }

  // Deduplicate cycles by canonical key
  const seen = new Set<string>();
  return cycles.filter((c) => {
    const key = c.path.join("->");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// -------------------------------------------------------------------------
// DOT output
// -------------------------------------------------------------------------

/**
 * Renders the dependency graph as a Graphviz DOT string.
 * Cycle nodes are highlighted in red.
 */
export function toDot(graph: DepGraph, cycles: Cycle[] = []): string {
  const cycleNodes = new Set<string>();
  const cycleEdges = new Set<string>();
  for (const cycle of cycles) {
    for (let i = 0; i < cycle.path.length - 1; i++) {
      cycleNodes.add(cycle.path[i]);
      cycleEdges.add(`${cycle.path[i]}->${cycle.path[i + 1]}`);
    }
  }

  const lines: string[] = ["digraph monorepo {", '  rankdir="LR";', '  node [fontname="Helvetica", shape=box];', ""];

  const apps: string[] = [];
  const pkgs: string[] = [];
  const other: string[] = [];

  for (const [name, node] of graph.nodes) {
    if (node.path.includes("/apps/")) {
      apps.push(name);
    } else if (node.path.includes("/packages/")) {
      pkgs.push(name);
    } else {
      other.push(name);
    }
  }

  function safeName(n: string) {
    return `"${n}"`;
  }

  function nodeDecl(name: string) {
    const isInCycle = cycleNodes.has(name);
    const label = name.replace("@8gent/", "").replace("@podjamz/", "podjamz/");
    const attrs = isInCycle
      ? `[label=${safeName(label)}, style=filled, fillcolor=red, fontcolor=white]`
      : `[label=${safeName(label)}]`;
    return `  ${safeName(name)} ${attrs};`;
  }

  if (apps.length) {
    lines.push("  subgraph cluster_apps {");
    lines.push('    label="apps";');
    lines.push('    style=dashed;');
    for (const n of apps.sort()) lines.push("  " + nodeDecl(n));
    lines.push("  }");
    lines.push("");
  }

  if (pkgs.length) {
    lines.push("  subgraph cluster_packages {");
    lines.push('    label="packages";');
    lines.push('    style=dashed;');
    for (const n of pkgs.sort()) lines.push("  " + nodeDecl(n));
    lines.push("  }");
    lines.push("");
  }

  for (const n of other.sort()) lines.push(nodeDecl(n));
  lines.push("");

  for (const [from, deps] of graph.edges) {
    for (const to of deps) {
      const key = `${from}->${to}`;
      const isCycleEdge = cycleEdges.has(key);
      const attrs = isCycleEdge ? " [color=red, penwidth=2]" : "";
      lines.push(`  ${safeName(from)} -> ${safeName(to)}${attrs};`);
    }
  }

  lines.push("}");
  return lines.join("\n");
}

// -------------------------------------------------------------------------
// CLI
// -------------------------------------------------------------------------

function printUsage() {
  console.log(`
Usage: bun packages/tools/dep-graph.ts [options]

Options:
  --root <path>   Root of monorepo (default: cwd)
  --dot           Output Graphviz DOT format
  --cycles        Only report cycles (exit 1 if any found)
  --json          Output raw graph as JSON
  -h, --help      Show this help

Examples:
  bun packages/tools/dep-graph.ts --dot
  bun packages/tools/dep-graph.ts --cycles
  bun packages/tools/dep-graph.ts --json | jq '.nodes | keys'
`.trim());
}

const isMain =
  typeof Bun !== "undefined"
    ? import.meta.path === Bun.main
    : process.argv[1]?.endsWith("dep-graph.ts") || process.argv[1]?.endsWith("dep-graph.js");

if (isMain) {
  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    printUsage();
    process.exit(0);
  }

  const rootIdx = args.indexOf("--root");
  const root = rootIdx !== -1 && args[rootIdx + 1] ? args[rootIdx + 1] : process.cwd();
  const dotMode = args.includes("--dot");
  const cyclesMode = args.includes("--cycles");
  const jsonMode = args.includes("--json");

  const graph = buildGraph(root);
  const cycles = detectCycles(graph);

  if (dotMode) {
    console.log(toDot(graph, cycles));
  } else if (cyclesMode) {
    if (cycles.length === 0) {
      console.log("No cycles detected. Graph is a valid DAG.");
      process.exit(0);
    } else {
      console.error(`Found ${cycles.length} cycle(s):`);
      for (const c of cycles) {
        console.error("  " + c.path.join(" -> "));
      }
      process.exit(1);
    }
  } else if (jsonMode) {
    const out = {
      nodes: Object.fromEntries(
        [...graph.nodes.entries()].map(([k, v]) => [k, { path: v.path, deps: v.deps }])
      ),
      edges: Object.fromEntries(graph.edges),
      cycles: cycles.map((c) => c.path),
    };
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log("Monorepo Dependency Graph");
    console.log("=========================");
    console.log(`Root: ${root}`);
    console.log(`Packages: ${graph.nodes.size}`);
    console.log(`Internal edges: ${[...graph.edges.values()].reduce((s, v) => s + v.length, 0)}`);
    console.log(`Cycles: ${cycles.length}`);
    console.log("");

    const sorted = [...graph.nodes.keys()].sort();
    for (const name of sorted) {
      const deps = graph.edges.get(name) ?? [];
      if (deps.length) {
        console.log(`  ${name}`);
        for (const d of deps) console.log(`    -> ${d}`);
      } else {
        console.log(`  ${name}  (no internal deps)`);
      }
    }

    if (cycles.length) {
      console.log("\nCycles detected:");
      for (const c of cycles) {
        console.log("  " + c.path.join(" -> "));
      }
    }
  }
}
