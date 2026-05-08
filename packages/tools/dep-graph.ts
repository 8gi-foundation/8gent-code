/**
 * dep-graph.ts - Monorepo dependency graph generator
 *
 * Scans package.json files across apps/ and packages/ to build an internal
 * dependency graph. Outputs as Mermaid diagram, plain text, or JSON.
 *
 * Usage:
 *   bun run packages/tools/dep-graph.ts              # Mermaid (default)
 *   bun run packages/tools/dep-graph.ts --format=text # Plain text
 *   bun run packages/tools/dep-graph.ts --format=json # JSON adjacency list
 */

import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

interface PkgInfo {
  name: string;
  dir: string;
  deps: string[];
}

type Format = "mermaid" | "text" | "json";

const ROOT = resolve(import.meta.dir, "../..");
const WS_DIRS = ["packages", "apps"];

async function discover(): Promise<Map<string, PkgInfo>> {
  const pkgs = new Map<string, PkgInfo>();
  const rawDeps = new Map<string, Record<string, string>>();

  for (const ws of WS_DIRS) {
    const base = join(ROOT, ws);
    let entries: string[];
    try { entries = await readdir(base); } catch { continue; }

    for (const entry of entries) {
      try {
        const raw = await readFile(join(base, entry, "package.json"), "utf-8");
        const pkg = JSON.parse(raw);
        const name: string = pkg.name ?? entry;
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
        pkgs.set(name, { name, dir: `${ws}/${entry}`, deps: [] });
        rawDeps.set(name, allDeps);
      } catch { /* skip */ }
    }
  }

  // Link phase - resolve internal deps
  const known = new Set(pkgs.keys());
  for (const [name, deps] of rawDeps) {
    const info = pkgs.get(name)!;
    info.deps = Object.keys(deps).filter((d) => known.has(d));
  }

  return pkgs;
}

function toMermaid(pkgs: Map<string, PkgInfo>): string {
  const lines: string[] = ["graph LR"];
  const ids = new Map<string, string>();
  let i = 0;

  for (const [name, info] of pkgs) {
    const id = `p${i++}`;
    ids.set(name, id);
    lines.push(`  ${id}["${info.dir}"]`);
  }

  let edges = 0;
  for (const [name, info] of pkgs) {
    for (const dep of info.deps) {
      const to = ids.get(dep);
      if (to) { lines.push(`  ${ids.get(name)} --> ${to}`); edges++; }
    }
  }

  if (edges === 0) {
    lines.push("  %% No internal cross-package deps declared in package.json");
    lines.push("  %% Most packages use direct file imports instead");
  }
  return lines.join("\n");
}

function toText(pkgs: Map<string, PkgInfo>): string {
  const sorted = [...pkgs.values()].sort((a, b) => a.dir.localeCompare(b.dir));
  const lines: string[] = ["=== Monorepo Dependency Graph ===", ""];

  for (const info of sorted) {
    if (info.deps.length > 0) {
      lines.push(`${info.dir} (${info.name})`);
      for (const dep of info.deps) {
        lines.push(`  -> ${pkgs.get(dep)?.dir ?? dep}`);
      }
      lines.push("");
    }
  }

  const noDeps = sorted.filter((p) => p.deps.length === 0);
  if (noDeps.length > 0) {
    lines.push("--- No declared internal dependencies ---");
    for (const info of noDeps) lines.push(`  ${info.dir} (${info.name})`);
  }
  return lines.join("\n");
}

function toJson(pkgs: Map<string, PkgInfo>): string {
  const graph: Record<string, string[]> = {};
  for (const [, info] of pkgs)
    graph[info.dir] = info.deps.map((d) => pkgs.get(d)?.dir ?? d);
  return JSON.stringify(graph, null, 2);
}

async function main(): Promise<void> {
  const fmt = (process.argv.find((a) => a.startsWith("--format="))?.split("=")[1] ?? "mermaid") as Format;
  const pkgs = await discover();
  const render = { mermaid: toMermaid, text: toText, json: toJson }[fmt] ?? toMermaid;
  console.log(render(pkgs));
}

main().catch((err) => { console.error("dep-graph error:", err.message); process.exit(1); });
