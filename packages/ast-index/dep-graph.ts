/**
 * 8gent Dependency Graph
 *
 * Builds an import/export dependency graph from a codebase using
 * regex-based import parsing - fast, no AST parser dependency.
 */

import * as fs from "fs";
import * as path from "path";

export interface DepNode {
  imports: string[];      // absolute paths this file imports
  exportedBy: string[];   // absolute paths that import this file (reverse map)
}

export interface DepGraph {
  nodes: Map<string, DepNode>;
  rootDir: string;
}

const IMPORT_RE = /(?:import\s+(?:[\w*{},\s]+\s+from\s+)?|require\s*\()\s*['"]([^'"]+)['"]/g;
const IGNORE_DIRS = new Set(["node_modules", "dist", ".git", ".next", "coverage", ".8gent"]);
const SOURCE_EXTS = [".ts", ".tsx", ".js", ".jsx"];
const RESOLVE_EXTS = [...SOURCE_EXTS, "/index.ts", "/index.tsx", "/index.js", "/index.jsx"];

/** Walk a directory and collect all source files */
function walkDir(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || IGNORE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkDir(full));
    } else if (SOURCE_EXTS.some(ext => entry.name.endsWith(ext))) {
      files.push(full);
    }
  }
  return files;
}

/** Resolve a relative import specifier to an absolute file path */
function resolveImport(specifier: string, fromFile: string, rootDir: string): string | null {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
  for (const suffix of RESOLVE_EXTS) {
    const candidate = base + suffix;
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Extract all import specifiers from a file's source text */
function extractImports(content: string): string[] {
  const specifiers: string[] = [];
  let match: RegExpExecArray | null;
  IMPORT_RE.lastIndex = 0;
  while ((match = IMPORT_RE.exec(content)) !== null) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

/**
 * Build a dependency graph for all source files under rootDir.
 * Runs in O(files) with cheap regex parsing.
 */
export function buildDepGraph(rootDir: string): DepGraph {
  const absRoot = path.resolve(rootDir);
  const files = walkDir(absRoot);
  const graph: DepGraph = { nodes: new Map(), rootDir: absRoot };

  for (const file of files) {
    graph.nodes.set(file, { imports: [], exportedBy: [] });
  }

  for (const file of files) {
    let content: string;
    try { content = fs.readFileSync(file, "utf-8"); } catch { continue; }

    const specifiers = extractImports(content);
    const node = graph.nodes.get(file)!;

    for (const spec of specifiers) {
      const resolved = resolveImport(spec, file, absRoot);
      if (!resolved || !graph.nodes.has(resolved)) continue;
      if (!node.imports.includes(resolved)) node.imports.push(resolved);
      const target = graph.nodes.get(resolved)!;
      if (!target.exportedBy.includes(file)) target.exportedBy.push(file);
    }
  }

  return graph;
}
