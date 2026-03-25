/**
 * codemod.ts
 * Bulk find/replace codemod runner for 8gent tooling.
 *
 * Features:
 * - Regex find/replace with capture group support
 * - Glob-based file filtering
 * - Dry-run mode (preview changes, write nothing)
 * - Built-in codemods for common refactors
 * - CLI entry point via: bun packages/tools/codemod.ts
 */

import { readdir, readFile, writeFile, stat } from "fs/promises";
import { join, relative } from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CodemodDef {
  /** Human-readable name */
  name: string;
  /** Description of what this codemod does */
  description: string;
  /** Regex pattern to find (supports capture groups) */
  find: RegExp;
  /** Replacement string (supports $1, $2 etc for capture groups) */
  replace: string;
  /** Glob pattern for files to include. Default: **\/*.{ts,tsx,js,jsx} */
  glob?: string;
  /** Additional file patterns to exclude */
  exclude?: string[];
}

export interface CodemodResult {
  file: string;
  matchCount: number;
  before: string;
  after: string;
  changed: boolean;
}

export interface RunOptions {
  /** Root directory to scan. Default: process.cwd() */
  root?: string;
  /** If true, log changes to stdout but do not write files */
  dryRun?: boolean;
  /** Suppress all output */
  quiet?: boolean;
}

export interface RunSummary {
  codemod: string;
  filesScanned: number;
  filesChanged: number;
  totalMatches: number;
  results: CodemodResult[];
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Built-in codemods
// ---------------------------------------------------------------------------

export const BUILT_IN_CODEMODS: Record<string, CodemodDef> = {
  /**
   * Replace gray/white/black Ink color props with safe alternatives.
   * Per TUI Color Rules in CLAUDE.md.
   */
  "ink-safe-colors": {
    name: "ink-safe-colors",
    description:
      'Replace banned Ink color props (gray/white/black) with dimColor or safe colors',
    find: /\bcolor="(gray|white|black)"\b/g,
    replace: "dimColor",
    glob: "**/*.{ts,tsx}",
    exclude: ["node_modules", "dist", ".git"],
  },

  /**
   * Replace em dashes with hyphens. Prohibited by project rules.
   */
  "no-em-dashes": {
    name: "no-em-dashes",
    description: "Replace em dashes (U+2014) with hyphens (-) in all text files",
    find: /\u2014/g,
    replace: "-",
    glob: "**/*.{ts,tsx,js,jsx,md,json}",
    exclude: ["node_modules", "dist", ".git"],
  },

  /**
   * Migrate console.log debug calls to a structured logger pattern.
   */
  "console-to-debug": {
    name: "console-to-debug",
    description:
      "Replace console.log with debug() calls (import debug from your logger)",
    find: /console\.log\((.+?)\)/g,
    replace: "debug($1)",
    glob: "**/*.{ts,tsx}",
    exclude: ["node_modules", "dist", ".git", "**/*.test.ts", "**/*.spec.ts"],
  },

  /**
   * Migrate require() to import statements (CommonJS -> ESM).
   */
  "require-to-import": {
    name: "require-to-import",
    description: "Replace const x = require('y') with import x from 'y'",
    find: /const (\w+) = require\(['"]([^'"]+)['"]\);?/g,
    replace: "import $1 from '$2';",
    glob: "**/*.{ts,tsx,js,jsx}",
    exclude: ["node_modules", "dist", ".git"],
  },

  /**
   * Replace hardcoded localhost URLs with environment variable reference.
   */
  "localhost-to-env": {
    name: "localhost-to-env",
    description:
      "Replace hardcoded http://localhost:PORT with process.env.API_URL",
    find: /['"]http:\/\/localhost:\d+['"]/g,
    replace: "process.env.API_URL",
    glob: "**/*.{ts,tsx,js,jsx}",
    exclude: ["node_modules", "dist", ".git", "**/*.test.ts", "**/*.spec.ts"],
  },

  /**
   * Flag .then().catch() chains for manual review.
   */
  "then-to-await": {
    name: "then-to-await",
    description:
      "Flag .then() chains with a TODO comment for async/await migration",
    find: /\.then\(([^)]+)\)\.catch\(([^)]+)\)/g,
    replace: "/* TODO: convert to async/await - was .then($1).catch($2) */",
    glob: "**/*.{ts,tsx,js,jsx}",
    exclude: ["node_modules", "dist", ".git"],
  },
};

// ---------------------------------------------------------------------------
// File scanning
// ---------------------------------------------------------------------------

/** Simple glob-to-regex converter supporting ** patterns */
function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/\./g, "\\.")
    .replace(/\*\*\//g, "(.*/)?")
    .replace(/\*/g, "[^/]*")
    .replace(/\{([^}]+)\}/g, (_, group) => `(${group.split(",").join("|")})`);
  return new RegExp(`^${escaped}$`);
}

async function scanFiles(
  root: string,
  glob: string,
  exclude: string[] = []
): Promise<string[]> {
  const results: string[] = [];
  const includeRe = globToRegex(glob);
  const excludeRes = exclude.map(globToRegex);

  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const relPath = relative(root, fullPath);

      if (excludeRes.some((re) => re.test(relPath) || re.test(entry))) {
        continue;
      }

      let info;
      try {
        info = await stat(fullPath);
      } catch {
        continue;
      }

      if (info.isDirectory()) {
        await walk(fullPath);
      } else if (includeRe.test(relPath)) {
        results.push(fullPath);
      }
    }
  }

  await walk(root);
  return results;
}

// ---------------------------------------------------------------------------
// Core runner
// ---------------------------------------------------------------------------

function applyCodemod(content: string, def: CodemodDef): string {
  def.find.lastIndex = 0;
  return content.replace(def.find, def.replace);
}

/**
 * Run a codemod in dry-run mode.
 * Returns a full RunSummary with diffs but writes nothing to disk.
 */
export async function dryRun(
  codemod: CodemodDef,
  options: RunOptions = {}
): Promise<RunSummary> {
  return _run(codemod, { ...options, dryRun: true });
}

/**
 * Run a codemod against a directory tree.
 * Pass { dryRun: true } to preview without writing.
 */
export async function runCodemod(
  codemod: CodemodDef,
  options: RunOptions = {}
): Promise<RunSummary> {
  return _run(codemod, options);
}

async function _run(
  codemod: CodemodDef,
  options: RunOptions
): Promise<RunSummary> {
  const root = options.root ?? process.cwd();
  const isDryRun = options.dryRun ?? false;
  const quiet = options.quiet ?? false;

  const glob = codemod.glob ?? "**/*.{ts,tsx,js,jsx}";
  const exclude = codemod.exclude ?? ["node_modules", "dist", ".git"];

  const files = await scanFiles(root, glob, exclude);

  const results: CodemodResult[] = [];
  let totalMatches = 0;

  for (const file of files) {
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }

    codemod.find.lastIndex = 0;
    const matches = content.match(new RegExp(codemod.find.source, codemod.find.flags));
    const matchCount = matches?.length ?? 0;

    if (matchCount === 0) continue;

    const after = applyCodemod(content, codemod);
    const changed = after !== content;

    results.push({
      file: relative(root, file),
      matchCount,
      before: content,
      after,
      changed,
    });

    totalMatches += matchCount;

    if (!isDryRun && changed) {
      await writeFile(file, after, "utf8");
    }

    if (!quiet) {
      const prefix = isDryRun ? "[dry-run]" : "[changed]";
      process.stdout.write(
        `${prefix} ${relative(root, file)} - ${matchCount} match${matchCount === 1 ? "" : "es"}\n`
      );
    }
  }

  const summary: RunSummary = {
    codemod: codemod.name,
    filesScanned: files.length,
    filesChanged: results.filter((r) => r.changed).length,
    totalMatches,
    results,
    dryRun: isDryRun,
  };

  if (!quiet) {
    const verb = isDryRun ? "Would change" : "Changed";
    process.stdout.write(
      `\n${codemod.name}: scanned ${files.length} files, ${verb} ${summary.filesChanged} (${totalMatches} total matches)\n`
    );
  }

  return summary;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function cli(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`
codemod - bulk find/replace runner

Usage:
  bun packages/tools/codemod.ts <codemod-name> [options]
  bun packages/tools/codemod.ts --list
  bun packages/tools/codemod.ts --custom --find <regex> --replace <string> [options]

Options:
  --list              List all built-in codemods
  --dry-run           Preview changes without writing
  --root <path>       Root directory to scan (default: cwd)
  --glob <pattern>    File glob pattern
  --exclude <pattern> Glob pattern to exclude (repeatable)
  --custom            Use --find and --replace to define a one-off codemod
  --find <regex>      Regex pattern for custom codemod
  --replace <string>  Replacement string for custom codemod

Examples:
  bun packages/tools/codemod.ts no-em-dashes --dry-run
  bun packages/tools/codemod.ts ink-safe-colors --root ./apps/tui
  bun packages/tools/codemod.ts --custom --find "OldName" --replace "NewName" --glob "**/*.ts"
`);
    return;
  }

  if (args.includes("--list")) {
    console.log("\nBuilt-in codemods:\n");
    for (const [key, def] of Object.entries(BUILT_IN_CODEMODS)) {
      console.log(`  ${key}`);
      console.log(`    ${def.description}`);
      console.log(`    glob: ${def.glob ?? "**/*.{ts,tsx,js,jsx}"}`);
      console.log();
    }
    return;
  }

  const isDryRun = args.includes("--dry-run");
  const rootIdx = args.indexOf("--root");
  const root = rootIdx !== -1 ? args[rootIdx + 1] : process.cwd();

  if (args.includes("--custom")) {
    const findIdx = args.indexOf("--find");
    const replaceIdx = args.indexOf("--replace");
    const globIdx = args.indexOf("--glob");
    const excludeIdxs = args.reduce<number[]>(
      (acc, a, i) => (a === "--exclude" ? [...acc, i] : acc),
      []
    );

    if (findIdx === -1 || replaceIdx === -1) {
      console.error("--custom requires both --find and --replace");
      process.exit(1);
    }

    const findRaw = args[findIdx + 1];
    const replaceStr = args[replaceIdx + 1];
    const glob = globIdx !== -1 ? args[globIdx + 1] : undefined;
    const exclude = excludeIdxs.map((i) => args[i + 1]);

    const codemod: CodemodDef = {
      name: "custom",
      description: `Custom: s/${findRaw}/${replaceStr}/`,
      find: new RegExp(findRaw, "g"),
      replace: replaceStr,
      glob,
      exclude: exclude.length > 0 ? exclude : undefined,
    };

    await _run(codemod, { root, dryRun: isDryRun });
    return;
  }

  const name = args[0];
  const def = BUILT_IN_CODEMODS[name];

  if (!def) {
    console.error(`Unknown codemod: "${name}". Run --list to see available codemods.`);
    process.exit(1);
  }

  const globIdx = args.indexOf("--glob");
  if (globIdx !== -1) def.glob = args[globIdx + 1];

  const excludeIdxs = args.reduce<number[]>(
    (acc, a, i) => (a === "--exclude" ? [...acc, i] : acc),
    []
  );
  if (excludeIdxs.length > 0) {
    def.exclude = excludeIdxs.map((i) => args[i + 1]);
  }

  await _run(def, { root, dryRun: isDryRun });
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1]?.endsWith("codemod.ts");

if (isMain) {
  cli().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
