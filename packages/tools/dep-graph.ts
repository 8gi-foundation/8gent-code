/**
 * packages/tools/dep-graph.ts
 *
 * Monorepo internal dependency graph scanner.
 * Scans package.json files, builds internal dep graph, detects cycles, outputs DOT.
 * Zero external deps - uses Bun/Node built-ins only.
 *
 * Exports: buildGraph(), detectCycles(), toDot()
 * CLI: bun packages/tools/dep-graph.ts [--dot] [--cycles] [--json] [--root <path>]
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

export interface PackageNode {
  name: string;
  path: string;
  deps: string[];
}

export interface DepGraph {
  nodes: Map<string, PackageNode>;
  edges: Map<string, string[]>;
}

export interface Cycle {
  path: string[];
}

const EXCLUDED_DIRS = new Set(["node_modules", ".next", ".git", "dist", "build"]);

function isInternalDep(name: string): boolean {
  return name.startsWith("@8gent/") || name.startsWith("@podjamz/");
}

function findPackageJsonFiles(root: string): string[] {
  const results: string[] = [];
  function walk(dir: string) {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (EXCLUDED_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      let stat;
      try { stat = statSync(full); } catch { continue; }
      if (stat.isDirectory()) walk(full);
      else if (entry === "package.json") results.push(full);
    }
  }
  walk(root);
  return results;
}

function parsePackageJson(filePath: string): PackageNode | null {
  let raw: string;
  try { raw = readFileSync(filePath, "utf8"); } catch { return null; }
  let pkg: Record<string, unknown>;
  try { pkg = JSON.parse(raw); } catch { return null; }
  const name = typeof pkg.name === "string" ? pkg.name.trim() : "";
  if (!name) return null;
  const allDeps: string[] = [
    ...Object.keys((pkg.dependencies as Record<string, string>) ?? {}),
    ...Object.keys((pkg.devDependencies as Record<string, string>) ?? {}),
    ...Object.keys((pkg.peerDependencies as Record<string, string>) ?? {}),
  ];
  return { name, path: filePath, deps: allDeps.filter(isInternalDep) };
}

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
    const isWorkspace = file.includes("/apps/") || file.includes("/packages/");
    const isScoped = isInternalDep(node.name);
    if (!isWorkspace && !isScoped) continue;
    nodes.set(node.name, node);
  }
  const edges = new Map<string, string[]>();
  for (const [name, node] of nodes) {
    edges.set(name, node.deps.filter((d) => nodes.has(d)));
  }
  return { nodes, edges };
}

/**
 * DFS-based cycle detection. Returns cycle paths or empty array for valid DAG.
 */
export function detectCycles(graph: DepGraph): Cycle[] {
  const cycles: Cycle[] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const stackPath: string[] = [];

  function dfs(node: string) {
    if (inStack.has(node)) {
      const start = stackPath.indexOf(node);
      const raw = [...stackPath.slice(start), node];
      const minIdx = raw.slice(0, -1).reduce((mi, n, i) => (n < raw[mi] ? i : mi), 0);
      const normalised = [...raw.slice(minIdx, raw.length - 1), ...raw.slice(0, minIdx), raw[minIdx]];
      cycles.push({ path: normalised });
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    inStack.add(node);
    stackPath.push(node);
    for (const dep of graph.edges.get(node) ?? []) dfs(dep);
    stackPath.pop();
    inStack.delete(node);
  }

  for (const name of graph.nodes.keys()) {
    if (!visited.has(name)) dfs(name);
  }

  const seen = new Set<string>();
  return cycles.filter((c) => {
    const key = c.path.join("->");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Renders the graph as Graphviz DOT. Cycle nodes/edges highlighted red.
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
  const lines = ["digraph monorepo {", '  rankdir="LR";', '  node [fontname="Helvetica", shape=box];', ""];
  const apps: string[] = [];
  const pkgs: string[] = [];
  const other: string[] = [];
  for (const [name, node] of graph.nodes) {
    if (node.path.includes("/apps/")) apps.push(name);
    else if (node.path.includes("/packages/")) pkgs.push(name);
    else other.push(name);
  }
  const q = (s: string) => `"${s}"`;
  const nodeDecl = (name: string) => {
    const label = name.replace("@8gent/", "").replace("@podjamz/", "podjamz/");
    const attrs = cycleNodes.has(name)
      ? `[label=${q(label)}, style=filled, fillcolor=red, fontcolor=white]`
      : `[label=${q(label)}]`;
    return `  ${q(name)} ${attrs};`;
  };
  if (apps.length) {
    lines.push("  subgraph cluster_apps {", '    label="apps";', "    style=dashed;");
    apps.sort().forEach((n) => lines.push("  " + nodeDecl(n)));
    lines.push("  }", "");
  }
  if (pkgs.length) {
    lines.push("  subgraph cluster_packages {", '    label="packages";', "    style=dashed;");
    pkgs.sort().forEach((n) => lines.push("  " + nodeDecl(n)));
    lines.push("  }", "");
  }
  other.sort().forEach((n) => lines.push(nodeDecl(n)));
  lines.push("");
  for (const [from, deps] of graph.edges) {
    for (const to of deps) {
      const isCycle = cycleEdges.has(`${from}->${to}`);
      lines.push(`  ${q(from)} -> ${q(to)}${isCycle ? " [color=red, penwidth=2]" : ""};`);
    }
  }
  lines.push("}");
  return lines.join("\n");
}

// CLI
const isMain = typeof Bun !== "undefined"
  ? import.meta.path === Bun.main
  : process.argv[1]?.endsWith("dep-graph.ts");

if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    console.log("Usage: bun packages/tools/dep-graph.ts [--dot|--cycles|--json] [--root <path>]");
    process.exit(0);
  }
  const rootIdx = args.indexOf("--root");
  const root = rootIdx !== -1 && args[rootIdx + 1] ? args[rootIdx + 1] : process.cwd();
  const graph = buildGraph(root);
  const cycles = detectCycles(graph);
  if (args.includes("--dot")) {
    console.log(toDot(graph, cycles));
  } else if (args.includes("--cycles")) {
    if (cycles.length === 0) { console.log("No cycles detected. Graph is a valid DAG."); process.exit(0); }
    else { console.error(`Found ${cycles.length} cycle(s):`); cycles.forEach((c) => console.error("  " + c.path.join(" -> "))); process.exit(1); }
  } else if (args.includes("--json")) {
    console.log(JSON.stringify({
      nodes: Object.fromEntries([...graph.nodes.entries()].map(([k, v]) => [k, { path: v.path, deps: v.deps }])),
      edges: Object.fromEntries(graph.edges),
      cycles: cycles.map((c) => c.path),
    }, null, 2));
  } else {
    const totalEdges = [...graph.edges.values()].reduce((s, v) => s + v.length, 0);
    console.log(`Monorepo Dependency Graph\n=========================\nRoot: ${root}\nPackages: ${graph.nodes.size}\nInternal edges: ${totalEdges}\nCycles: ${cycles.length}\n`);
    for (const name of [...graph.nodes.keys()].sort()) {
      const deps = graph.edges.get(name) ?? [];
      if (deps.length) { console.log(`  ${name}`); deps.forEach((d) => console.log(`    -> ${d}`)); }
      else console.log(`  ${name}  (no internal deps)`);
    }
    if (cycles.length) { console.log("\nCycles detected:"); cycles.forEach((c) => console.log("  " + c.path.join(" -> "))); }
  }
}
