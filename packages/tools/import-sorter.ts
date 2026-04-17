/**
 * TypeScript Import Sorter
 * Parses, categorizes, and sorts import statements by group.
 *
 * Groups (in order):
 *   1. Node built-ins      (node:fs, path, os, etc.)
 *   2. External packages   (react, lodash, etc.)
 *   3. Internal aliases    (@/, ~/, #/ paths)
 *   4. Relative imports    (./, ../)
 *
 * Within each group imports are sorted alphabetically by module path.
 */

const NODE_BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console",
  "constants", "crypto", "dgram", "diagnostics_channel", "dns", "domain",
  "events", "fs", "http", "http2", "https", "inspector", "module", "net",
  "os", "path", "perf_hooks", "process", "punycode", "querystring",
  "readline", "repl", "stream", "string_decoder", "sys", "timers", "tls",
  "trace_events", "tty", "url", "util", "v8", "vm", "wasi", "worker_threads",
  "zlib",
]);

export type ImportCategory = "builtin" | "external" | "internal" | "relative";

export interface ParsedImport {
  raw: string;
  module: string;
  category: ImportCategory;
}

/** Classify a module specifier into one of the four categories. */
export function classifyImport(module: string): ImportCategory {
  if (module.startsWith("node:")) return "builtin";
  if (module.startsWith(".")) return "relative";
  if (
    module.startsWith("@/") ||
    module.startsWith("~/") ||
    module.startsWith("#/")
  ) {
    return "internal";
  }
  const base = module.split("/")[0];
  if (NODE_BUILTINS.has(base)) return "builtin";
  return "external";
}

const IMPORT_RE =
  /^[ \t]*(import\s[\s\S]*?['"]([^'"]+)['"];?|import\s*['"]([^'"]+)['"];?)[ \t]*$/gm;

/** Extract all import statements with their positions. */
function extractImports(
  code: string
): Array<{ raw: string; start: number; end: number; module: string }> {
  const results: Array<{
    raw: string;
    start: number;
    end: number;
    module: string;
  }> = [];
  let match: RegExpExecArray | null;
  IMPORT_RE.lastIndex = 0;

  while ((match = IMPORT_RE.exec(code)) !== null) {
    const raw = match[0];
    const module = match[2] ?? match[3] ?? "";
    results.push({ raw, start: match.index, end: match.index + raw.length, module });
  }
  return results;
}

/** Sort a list of ParsedImports: by category order, then alphabetically. */
function sortImportList(imports: ParsedImport[]): ParsedImport[] {
  const order: Record<ImportCategory, number> = {
    builtin: 0,
    external: 1,
    internal: 2,
    relative: 3,
  };

  return [...imports].sort((a, b) => {
    const catDiff = order[a.category] - order[b.category];
    if (catDiff !== 0) return catDiff;
    return a.module.localeCompare(b.module);
  });
}

/** Build the sorted import block with blank lines between groups. */
function buildSortedBlock(sorted: ParsedImport[]): string {
  if (sorted.length === 0) return "";

  const lines: string[] = [];
  let lastCategory: ImportCategory | null = null;

  for (const imp of sorted) {
    if (lastCategory !== null && imp.category !== lastCategory) {
      lines.push(""); // blank line between groups
    }
    lines.push(imp.raw.trim());
    lastCategory = imp.category;
  }

  return lines.join("\n");
}

/**
 * Sort and group TypeScript import statements in a source file.
 *
 * @param code - Full TypeScript source as a string.
 * @returns Source code with imports sorted and grouped by category.
 */
export function sortImports(code: string): string {
  const found = extractImports(code);
  if (found.length === 0) return code;

  const parsed: ParsedImport[] = found.map((f) => ({
    raw: f.raw,
    module: f.module,
    category: classifyImport(f.module),
  }));

  const sorted = sortImportList(parsed);
  const newBlock = buildSortedBlock(sorted);

  // Replace the entire span from first import to last import (inclusive).
  const start = found[0].start;
  const end = found[found.length - 1].end;

  const before = code.slice(0, start);
  const after = code.slice(end);

  return before + newBlock + after;
}
