/**
 * path-resolver.ts
 *
 * Resolves TypeScript path aliases and monorepo package references to
 * absolute file paths. Useful for agent code navigation and import analysis.
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TsConfigPaths {
  [alias: string]: string[];
}

interface TsConfig {
  compilerOptions?: {
    baseUrl?: string;
    paths?: TsConfigPaths;
  };
  extends?: string;
}

export interface ResolveResult {
  absolutePath: string | null;
  source: "alias" | "package" | "not-found";
  matchedAlias?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Candidate index filenames to try when a directory is matched. */
const INDEX_FILES = ["index.ts", "index.tsx", "index.js", "index.mjs"];

/** Try to resolve a directory to its index file. */
function resolveDir(dirPath: string): string | null {
  for (const name of INDEX_FILES) {
    const candidate = join(dirPath, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Try a path with common TS extensions if no extension is present. */
function resolveWithExtensions(base: string): string | null {
  if (existsSync(base)) {
    const idx = resolveDir(base);
    return idx ?? base;
  }
  for (const ext of [".ts", ".tsx", ".js", ".mjs"]) {
    const candidate = `${base}${ext}`;
    if (existsSync(candidate)) return candidate;
  }
  return resolveDir(base);
}

/** Load and merge tsconfig, following `extends` one level deep. */
function loadTsConfig(tsconfigPath: string): TsConfig {
  try {
    const raw = readFileSync(tsconfigPath, "utf-8");
    // Strip single-line comments so JSON.parse handles real tsconfig files
    const stripped = raw.replace(/\/\/[^\n]*/g, "");
    const config: TsConfig = JSON.parse(stripped);

    if (config.extends) {
      const parentPath = resolve(dirname(tsconfigPath), config.extends);
      const resolved = existsSync(parentPath) ? parentPath : `${parentPath}.json`;
      const parent = loadTsConfig(resolved);
      config.compilerOptions = {
        ...parent.compilerOptions,
        ...config.compilerOptions,
        paths: {
          ...(parent.compilerOptions?.paths ?? {}),
          ...(config.compilerOptions?.paths ?? {}),
        },
      };
    }

    return config;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a TypeScript path alias to an absolute file path.
 *
 * Reads compilerOptions.paths from the given tsconfig (including extends
 * one level deep), matches the import string against all aliases (wildcard
 * @/* patterns supported), and returns the absolute file path.
 *
 * @param importPath   The import string as written in source (e.g. "@/lib/utils")
 * @param tsconfigPath Absolute path to the tsconfig.json to read paths from
 */
export function resolveAlias(
  importPath: string,
  tsconfigPath: string
): ResolveResult {
  const config = loadTsConfig(tsconfigPath);
  const paths = config.compilerOptions?.paths ?? {};
  const baseUrl = config.compilerOptions?.baseUrl
    ? resolve(dirname(tsconfigPath), config.compilerOptions.baseUrl)
    : dirname(tsconfigPath);

  for (const [alias, targets] of Object.entries(paths)) {
    const isWildcard = alias.endsWith("/*");
    const aliasBase = isWildcard ? alias.slice(0, -2) : alias;

    if (isWildcard && importPath.startsWith(aliasBase + "/")) {
      const suffix = importPath.slice(aliasBase.length + 1);
      for (const target of targets) {
        const targetBase = target.endsWith("/*") ? target.slice(0, -2) : target;
        const candidate = resolve(baseUrl, targetBase, suffix);
        const resolved = resolveWithExtensions(candidate);
        if (resolved) {
          return { absolutePath: resolved, source: "alias", matchedAlias: alias };
        }
      }
    } else if (!isWildcard && importPath === alias) {
      for (const target of targets) {
        const candidate = resolve(baseUrl, target);
        const resolved = resolveWithExtensions(candidate);
        if (resolved) {
          return { absolutePath: resolved, source: "alias", matchedAlias: alias };
        }
      }
    }
  }

  return { absolutePath: null, source: "not-found" };
}

/**
 * Resolve a monorepo package name to its entry-point file.
 *
 * Searches packages/, apps/, libs/, and modules/ under rootDir,
 * matches package.json by name, then resolves the entry point via
 * exports, main, module, or an index file fallback.
 *
 * @param name    Package name (e.g. "@8gent/memory")
 * @param rootDir Repo root directory to search within
 */
export function resolvePackage(name: string, rootDir: string): ResolveResult {
  const absRoot = resolve(rootDir);
  const searchDirs: string[] = [];

  for (const sub of ["packages", "apps", "libs", "modules"]) {
    const candidate = join(absRoot, sub);
    if (existsSync(candidate)) searchDirs.push(candidate);
  }

  for (const dir of searchDirs) {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const pkgJsonPath = join(dir, entry, "package.json");
      if (!existsSync(pkgJsonPath)) continue;

      try {
        const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
        if (pkg.name !== name) continue;

        const pkgDir = join(dir, entry);
        const main: string | undefined =
          pkg.exports?.["."]?.default ??
          pkg.exports?.["."] ??
          pkg.main ??
          pkg.module;

        if (main) {
          const resolved = resolve(pkgDir, main);
          if (existsSync(resolved)) {
            return { absolutePath: resolved, source: "package" };
          }
        }

        const idx = resolveDir(pkgDir);
        if (idx) return { absolutePath: idx, source: "package" };
      } catch {
        continue;
      }
    }
  }

  return { absolutePath: null, source: "not-found" };
}
