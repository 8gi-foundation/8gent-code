/**
 * dependency-checker.ts
 *
 * Scans source files against package.json to find:
 * - Unused dependencies (in package.json but never imported)
 * - Missing dependencies (imported in source but not in package.json)
 * - All declared dependencies with their versions
 *
 * Export: checkDeps(rootDir: string) => DepsReport
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join, extname } from "path";

export interface DepEntry {
  name: string;
  version: string;
  type: "dependency" | "devDependency" | "peerDependency";
}

export interface DepsReport {
  declared: DepEntry[];
  unused: DepEntry[];
  missing: string[];
  summary: {
    totalDeclared: number;
    totalUnused: number;
    totalMissing: number;
  };
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".8gent", "coverage"]);

// Regex captures: import ... from 'pkg', require('pkg'), import('pkg')
const IMPORT_RE =
  /(?:import\s+(?:[\w\s{},*]+\s+from\s+|type\s+[\w\s{},*]+\s+from\s+)|require\s*\(|import\s*\()['"]([^'"]+)['"]/g;

function walkFiles(dir: string, files: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    try {
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walkFiles(full, files);
      } else if (SOURCE_EXTENSIONS.has(extname(entry))) {
        files.push(full);
      }
    } catch {
      // skip unreadable entries
    }
  }
  return files;
}

function extractImports(filePath: string): Set<string> {
  const imports = new Set<string>();
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return imports;
  }
  let match: RegExpExecArray | null;
  IMPORT_RE.lastIndex = 0;
  while ((match = IMPORT_RE.exec(content)) !== null) {
    const specifier = match[1];
    // Skip relative imports and node: builtins
    if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
    // Extract package name (handle scoped packages)
    const parts = specifier.split("/");
    const pkgName = specifier.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
    if (pkgName) imports.add(pkgName);
  }
  return imports;
}

function loadPackageJson(rootDir: string): {
  deps: Record<string, string>;
  devDeps: Record<string, string>;
  peerDeps: Record<string, string>;
} {
  const pkgPath = join(rootDir, "package.json");
  let raw: string;
  try {
    raw = readFileSync(pkgPath, "utf8");
  } catch {
    throw new Error(`Cannot read package.json at ${pkgPath}`);
  }
  const pkg = JSON.parse(raw);
  return {
    deps: pkg.dependencies ?? {},
    devDeps: pkg.devDependencies ?? {},
    peerDeps: pkg.peerDependencies ?? {},
  };
}

export function checkDeps(rootDir: string): DepsReport {
  const { deps, devDeps, peerDeps } = loadPackageJson(rootDir);

  const declared: DepEntry[] = [
    ...Object.entries(deps).map(([name, version]) => ({ name, version, type: "dependency" as const })),
    ...Object.entries(devDeps).map(([name, version]) => ({ name, version, type: "devDependency" as const })),
    ...Object.entries(peerDeps).map(([name, version]) => ({ name, version, type: "peerDependency" as const })),
  ];

  const declaredNames = new Set(declared.map((d) => d.name));

  // Collect all imports from source files
  const allImports = new Set<string>();
  const sourceFiles = walkFiles(rootDir);
  for (const file of sourceFiles) {
    for (const imp of extractImports(file)) {
      allImports.add(imp);
    }
  }

  const unused = declared.filter((d) => !allImports.has(d.name));
  const missing = [...allImports].filter((imp) => !declaredNames.has(imp)).sort();

  return {
    declared,
    unused,
    missing,
    summary: {
      totalDeclared: declared.length,
      totalUnused: unused.length,
      totalMissing: missing.length,
    },
  };
}

// CLI usage: bun packages/tools/dependency-checker.ts [rootDir]
if (import.meta.main) {
  const rootDir = process.argv[2] ?? process.cwd();
  const report = checkDeps(rootDir);
  console.log(`\nDependency Report for: ${rootDir}`);
  console.log(`  Declared: ${report.summary.totalDeclared}`);
  console.log(`  Unused:   ${report.summary.totalUnused}`);
  console.log(`  Missing:  ${report.summary.totalMissing}`);
  if (report.unused.length > 0) {
    console.log("\nUnused:");
    for (const d of report.unused) console.log(`  - ${d.name}@${d.version} (${d.type})`);
  }
  if (report.missing.length > 0) {
    console.log("\nMissing (imported but not declared):");
    for (const m of report.missing) console.log(`  - ${m}`);
  }
}
