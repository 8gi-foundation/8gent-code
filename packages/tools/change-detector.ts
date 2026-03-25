/**
 * change-detector.ts
 * Detects changed files from git diff and maps them to affected tests and monorepo packages.
 * Self-contained - no external deps beyond bun stdlib.
 */

import { execSync } from "child_process";
import { existsSync, readdirSync } from "fs";
import { join, dirname, basename, extname } from "path";

export type ChangeCategory = "src" | "test" | "config" | "docs" | "other";

export interface ChangedFile {
  path: string;
  category: ChangeCategory;
  status: "added" | "modified" | "deleted" | "renamed";
}

export interface ChangeReport {
  files: ChangedFile[];
  affectedTestFiles: string[];
  affectedPackageNames: string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function runGit(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function categorize(filePath: string): ChangeCategory {
  const lower = filePath.toLowerCase();
  const name = basename(lower);
  const ext = extname(lower);

  if (
    name.includes(".test.") ||
    name.includes(".spec.") ||
    lower.includes("/__tests__/") ||
    lower.includes("/test/") ||
    lower.includes("/tests/")
  ) {
    return "test";
  }

  if (
    lower.endsWith(".md") ||
    lower.endsWith(".mdx") ||
    lower.startsWith("docs/") ||
    lower.includes("/docs/")
  ) {
    return "docs";
  }

  if (
    name === "package.json" ||
    name === "tsconfig.json" ||
    name === ".env" ||
    name === ".env.local" ||
    ext === ".yaml" ||
    ext === ".yml" ||
    ext === ".toml" ||
    name === "claude.md" ||
    name === "bun.lockb"
  ) {
    return "config";
  }

  if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx") {
    return "src";
  }

  return "other";
}

function parseGitStatus(raw: string): ChangedFile[] {
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const statusChar = line[0];
      const filePath = line.slice(2).trim().split(" -> ").pop() ?? "";
      let status: ChangedFile["status"] = "modified";
      if (statusChar === "A") status = "added";
      else if (statusChar === "D") status = "deleted";
      else if (statusChar === "R") status = "renamed";
      return { path: filePath, category: categorize(filePath), status };
    });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Collect changed files between two git refs (or working tree if omitted).
 */
export function detectChanges(base?: string, head?: string): ChangedFile[] {
  let raw: string;

  if (base && head) {
    raw = runGit(`git diff --name-status ${base} ${head}`);
  } else if (base) {
    raw = runGit(`git diff --name-status ${base}`);
  } else {
    // Staged + unstaged changes against HEAD
    const staged = runGit("git diff --name-status --cached");
    const unstaged = runGit("git diff --name-status");
    raw = [staged, unstaged].filter(Boolean).join("\n");
  }

  return parseGitStatus(raw);
}

/**
 * Map source files to their probable test counterparts by convention.
 * Checks for matching *.test.ts / *.spec.ts siblings or __tests__/ equivalents.
 */
export function affectedTests(changes: ChangedFile[]): string[] {
  const testFiles = new Set<string>();

  for (const change of changes) {
    // If the changed file is already a test, include it directly.
    if (change.category === "test") {
      testFiles.add(change.path);
      continue;
    }

    if (change.category !== "src") continue;

    const dir = dirname(change.path);
    const base = basename(change.path, extname(change.path));

    const candidates = [
      join(dir, `${base}.test.ts`),
      join(dir, `${base}.spec.ts`),
      join(dir, "__tests__", `${base}.test.ts`),
      join(dir, "__tests__", `${base}.spec.ts`),
    ];

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        testFiles.add(candidate);
      }
    }
  }

  return Array.from(testFiles).sort();
}

/**
 * Return the names of monorepo packages (apps/* or packages/*) that contain
 * at least one changed file.
 */
export function affectedPackages(
  changes: ChangedFile[],
  rootDir: string = process.cwd()
): string[] {
  const pkgRoots = new Set<string>();

  // Collect known package dirs from apps/ and packages/
  const workspaceDirs = ["apps", "packages"];
  for (const ws of workspaceDirs) {
    const wsPath = join(rootDir, ws);
    if (!existsSync(wsPath)) continue;
    for (const entry of readdirSync(wsPath)) {
      const full = join(ws, entry);
      pkgRoots.add(full);
    }
  }

  const affected = new Set<string>();

  for (const change of changes) {
    for (const pkgRoot of pkgRoots) {
      if (change.path.startsWith(pkgRoot + "/") || change.path === pkgRoot) {
        // Use just the package directory name as the identifier
        const parts = pkgRoot.split("/");
        affected.add(parts.join("/"));
        break;
      }
    }
  }

  return Array.from(affected).sort();
}

/**
 * Convenience: run full detection and return a structured report.
 */
export function detectChangeReport(
  base?: string,
  head?: string,
  rootDir: string = process.cwd()
): ChangeReport {
  const files = detectChanges(base, head);
  return {
    files,
    affectedTestFiles: affectedTests(files),
    affectedPackageNames: affectedPackages(files, rootDir),
  };
}
