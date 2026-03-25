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
import { resolve, relative, dirname } from "path";

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

const EXPORT_RE =
  /^export\s+(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/gm;
const NAMED_EXPORT_RE = /^export\s*\{([^}]+)\}/gm;
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
  file: string,
): Omit<UnusedExport, "file">[] {
  const results: Omit<UnusedExport, "file">[] = [];
  const lines = content.split("\n");

  // Direct exports: export function foo / export class Bar / export const baz
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
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
    }
  }

  // Named re-exports: export { Foo, Bar }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const reExport = line.match(/^export\s*\{([^}]+)\}/);
    if (reExport) {
      const names = reExport[1].split(",").map((n) => {
        const parts = n.trim().split(/\s+as\s+/);
        return parts[parts.length - 1].trim();
      });
      for (const name of names) {
        if (name && !name.startsWith("type ")) {
          results.push({ name: name.replace(/^type\s+/, ""), line: i + 1, kind: "other" });
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
  // A name is "used" if it appears in an import statement in any other file
  const importPatterns = [
    new RegExp(`\\b${name}\\b`), // appears in file at all
  ];

  for (const file of allFiles) {
    if (file === originFile) continue;
    const content = contentsCache.get(file) ?? "";
    // Quick check - does the name even appear?
    if (!content.includes(name)) continue;
    // Check it appears in an import or destructured usage context
    const hasImport = new RegExp(
      `import\\s+.*\\b${name}\\b.*from\\s+`,
    ).test(content);
    const hasRequire = new RegExp(
      `require\\(.*\\).*\\b${name}\\b`,
    ).test(content);
    if (hasImport || hasRequire) return true;
  }
  return false;
}

export function findDeadCode(root: string): DeadCodeReport {
  const files = collectSourceFiles(root);
  const contentsCache = new Map<string, string>();

  // Read all files into cache
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
    const exports = extractExports(content, file);
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
        console.log(`  ${exp.kind.padEnd(8)} ${exp.name.padEnd(30)} ${exp.file}:${exp.line}`);
      }
    }
  }
}
