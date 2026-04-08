/**
 * Dead Code Finder
 *
 * Scans the monorepo for exported functions/classes that are never imported
 * anywhere else in the codebase. Reports them as candidates for removal.
 *
 * Usage:
 *   bun run packages/validation/dead-code-finder.ts [--json] [--root path]
 */

import { Glob } from "bun";
import { readFileSync } from "fs";
import { resolve, relative } from "path";

export interface UnusedExport {
  name: string;
  file: string;
  line: number;
  kind: "function" | "class" | "const" | "type" | "other";
}

export interface DeadCodeReport {
  scannedFiles: number;
  totalExports: number;
  unusedExports: UnusedExport[];
  timestamp: string;
}

const IGNORE_DIRS = /node_modules|\.git|dist|\.next|\.turbo|\.8gent/;

function collectSourceFiles(root: string): string[] {
  const glob = new Glob("**/*.{ts,tsx,js,jsx}");
  const files: string[] = [];
  for (const path of glob.scanSync({ cwd: root })) {
    if (IGNORE_DIRS.test(path)) continue;
    files.push(resolve(root, path));
  }
  return files;
}

function extractExports(
  content: string,
): Omit<UnusedExport, "file">[] {
  const results: Omit<UnusedExport, "file">[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Direct exports: export function foo / export class Bar / export const baz
    const match = line.match(
      /^export\s+(?:async\s+)?(?:(function|class|const|let|var|type|interface|enum))\s+(\w+)/,
    );
    if (match) {
      const [, keyword, name] = match;
      const kind = (["function", "class", "const", "type"].includes(keyword)
        ? keyword === "let" || keyword === "var"
          ? "const"
          : keyword === "interface" || keyword === "enum"
            ? "type"
            : keyword
        : "other") as UnusedExport["kind"];
      results.push({ name, line: i + 1, kind });
      continue;
    }

    // Named re-exports: export { Foo, Bar } from "./module"
    const reExport = line.match(/^export\s*\{([^}]+)\}/);
    if (reExport) {
      const names = reExport[1].split(",").map((n) => {
        const cleaned = n.trim().replace(/^type\s+/, "");
        const parts = cleaned.split(/\s+as\s+/);
        return parts[parts.length - 1].trim();
      });
      for (const name of names) {
        if (name) {
          results.push({ name, line: i + 1, kind: "other" });
        }
      }
    }
  }

  return results;
}

function isImportedAnywhere(
  name: string,
  originFile: string,
  allFiles: string[],
  contentsCache: Map<string, string>,
): boolean {
  const importRe = new RegExp(`import\\s+.*\\b${name}\\b.*from\\s+`);
  const requireRe = new RegExp(`require\\(.*\\).*\\b${name}\\b`);

  for (const file of allFiles) {
    if (file === originFile) continue;
    const content = contentsCache.get(file) ?? "";
    if (!content.includes(name)) continue;
    if (importRe.test(content) || requireRe.test(content)) return true;
  }
  return false;
}

export function findDeadCode(root: string): DeadCodeReport {
  const files = collectSourceFiles(root);
  const contentsCache = new Map<string, string>();

  for (const file of files) {
    try {
      contentsCache.set(file, readFileSync(file, "utf-8"));
    } catch {
      // skip unreadable files
    }
  }

  const allExports: UnusedExport[] = [];
  const unused: UnusedExport[] = [];

  for (const file of files) {
    const content = contentsCache.get(file);
    if (!content) continue;
    const exports = extractExports(content);
    for (const exp of exports) {
      const entry: UnusedExport = { ...exp, file: relative(root, file) };
      allExports.push(entry);
      if (!isImportedAnywhere(exp.name, file, files, contentsCache)) {
        unused.push(entry);
      }
    }
  }

  return {
    scannedFiles: files.length,
    totalExports: allExports.length,
    unusedExports: unused,
    timestamp: new Date().toISOString(),
  };
}

// CLI entrypoint
if (import.meta.main) {
  const root = process.argv.includes("--root")
    ? resolve(process.argv[process.argv.indexOf("--root") + 1])
    : resolve(import.meta.dir, "../..");

  const jsonMode = process.argv.includes("--json");

  console.log(`Scanning ${root} for dead code...\n`);
  const report = findDeadCode(root);

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Files scanned: ${report.scannedFiles}`);
    console.log(`Total exports: ${report.totalExports}`);
    console.log(`Unused exports: ${report.unusedExports.length}\n`);

    if (report.unusedExports.length === 0) {
      console.log("No dead exports found.");
    } else {
      console.log("Candidates for removal:\n");
      for (const exp of report.unusedExports) {
        console.log(
          `  ${exp.kind.padEnd(8)} ${exp.name.padEnd(30)} ${exp.file}:${exp.line}`,
        );
      }
    }
  }
}
