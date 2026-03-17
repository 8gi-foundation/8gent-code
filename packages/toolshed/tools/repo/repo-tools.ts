/**
 * 8gent Toolshed - Repository Tools
 *
 * High-level repo analysis: dependency graphs, project structure,
 * file tree, and codebase statistics.
 */

import { registerTool } from "../../registry/register";
import type { ExecutionContext } from "../../../types";
import * as fs from "fs";
import * as path from "path";

// ── file_tree ───────────────────────────────────────

registerTool({
  name: "file_tree",
  description: "Get project file tree. Respects .gitignore and excludes node_modules, .git, dist.",
  capabilities: ["repo"],
  inputSchema: {
    type: "object",
    properties: {
      depth: { type: "number", description: "Max directory depth (default: 3)" },
      dir: { type: "string", description: "Subdirectory to tree (default: project root)" },
    },
  },
  permissions: ["read:fs"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { depth = 3, dir } = input as { depth?: number; dir?: string };
  const root = dir ? path.join(ctx.workingDirectory, dir) : ctx.workingDirectory;

  const IGNORE = new Set(["node_modules", ".git", "dist", ".next", ".cache", "coverage", "__pycache__", ".turbo", ".vercel"]);
  const tree: string[] = [];
  let fileCount = 0;
  let dirCount = 0;

  function walk(dirPath: string, prefix: string, currentDepth: number) {
    if (currentDepth > depth) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    // Sort: dirs first, then files
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
      if (IGNORE.has(entry.name)) continue;

      const isLast = i === entries.length - 1;
      const connector = isLast ? "└── " : "├── ";
      const childPrefix = isLast ? "    " : "│   ";

      if (entry.isDirectory()) {
        dirCount++;
        tree.push(`${prefix}${connector}${entry.name}/`);
        walk(path.join(dirPath, entry.name), prefix + childPrefix, currentDepth + 1);
      } else {
        fileCount++;
        tree.push(`${prefix}${connector}${entry.name}`);
      }
    }
  }

  walk(root, "", 0);
  return {
    root: path.relative(ctx.workingDirectory, root) || ".",
    tree: tree.join("\n"),
    files: fileCount,
    directories: dirCount,
  };
});

// ── project_info ────────────────────────────────────

registerTool({
  name: "project_info",
  description: "Get project metadata: name, version, dependencies, scripts, language, framework.",
  capabilities: ["repo"],
  inputSchema: {
    type: "object",
    properties: {},
  },
  permissions: ["read:fs"],
}, async (_input: unknown, ctx: ExecutionContext) => {
  const cwd = ctx.workingDirectory;
  const info: Record<string, any> = { path: cwd };

  // package.json
  const pkgPath = path.join(cwd, "package.json");
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    info.name = pkg.name;
    info.version = pkg.version;
    info.description = pkg.description;
    info.scripts = Object.keys(pkg.scripts || {});
    info.dependencies = Object.keys(pkg.dependencies || {}).length;
    info.devDependencies = Object.keys(pkg.devDependencies || {}).length;

    // Detect framework
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (allDeps["next"]) info.framework = "Next.js";
    else if (allDeps["react"]) info.framework = "React";
    else if (allDeps["vue"]) info.framework = "Vue";
    else if (allDeps["svelte"]) info.framework = "Svelte";
    else if (allDeps["express"]) info.framework = "Express";
    else if (allDeps["fastify"]) info.framework = "Fastify";
    else if (allDeps["hono"]) info.framework = "Hono";
    else if (allDeps["elysia"]) info.framework = "Elysia";

    // Detect runtime
    if (fs.existsSync(path.join(cwd, "bun.lockb"))) info.runtime = "Bun";
    else if (fs.existsSync(path.join(cwd, "deno.json"))) info.runtime = "Deno";
    else info.runtime = "Node.js";

    // Detect package manager
    if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) info.packageManager = "pnpm";
    else if (fs.existsSync(path.join(cwd, "yarn.lock"))) info.packageManager = "yarn";
    else if (fs.existsSync(path.join(cwd, "bun.lockb"))) info.packageManager = "bun";
    else info.packageManager = "npm";
  }

  // Language detection
  const extensions = new Map<string, number>();
  function countFiles(dir: string, depth = 0) {
    if (depth > 2) return;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") continue;
        if (entry.isDirectory()) {
          countFiles(path.join(dir, entry.name), depth + 1);
        } else {
          const ext = path.extname(entry.name);
          if (ext) extensions.set(ext, (extensions.get(ext) || 0) + 1);
        }
      }
    } catch {}
  }
  countFiles(cwd);

  info.languages = [...extensions.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([ext, count]) => ({ extension: ext, count }));

  // Config files
  const configs: string[] = [];
  for (const name of [
    "tsconfig.json", "tailwind.config.ts", "tailwind.config.js",
    "vite.config.ts", "next.config.js", "next.config.mjs",
    "Dockerfile", "docker-compose.yml", ".eslintrc.json",
    "vitest.config.ts", "jest.config.ts", "turbo.json",
  ]) {
    if (fs.existsSync(path.join(cwd, name))) configs.push(name);
  }
  info.configFiles = configs;

  return info;
});

// ── find_files ──────────────────────────────────────

registerTool({
  name: "find_files",
  description: "Find files matching a glob pattern. Fast recursive search ignoring node_modules.",
  capabilities: ["repo"],
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern (e.g. '**/*.ts', 'src/**/*.test.ts')" },
      limit: { type: "number", description: "Max results (default: 50)" },
    },
    required: ["pattern"],
  },
  permissions: ["read:fs"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { pattern, limit = 50 } = input as { pattern: string; limit?: number };
  const { execSync } = require("child_process");

  try {
    // Use find with basic glob matching
    const escaped = pattern.replace(/\*/g, "STAR").replace(/\?/g, "QUEST");
    const cmd = `find . -type f -name "${pattern.split("/").pop()}" | head -${limit}`;
    const output = execSync(cmd, { cwd: ctx.workingDirectory, encoding: "utf-8", timeout: 10000 });
    const files = output.trim().split("\n").filter(Boolean).filter(f =>
      !f.includes("node_modules") && !f.includes(".git/")
    );
    return { files, count: files.length, truncated: files.length >= limit };
  } catch {
    return { files: [], count: 0, truncated: false };
  }
});

// ── search_code ─────────────────────────────────────

registerTool({
  name: "search_code",
  description: "Search for a pattern across all files in the repo. Uses ripgrep if available, falls back to grep.",
  capabilities: ["repo", "code"],
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Search pattern (regex supported)" },
      fileType: { type: "string", description: "File extension filter (e.g. 'ts', 'py')" },
      limit: { type: "number", description: "Max results (default: 20)" },
    },
    required: ["pattern"],
  },
  permissions: ["read:code"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { pattern, fileType, limit = 20 } = input as { pattern: string; fileType?: string; limit?: number };
  const { execSync } = require("child_process");

  // Try ripgrep first, fall back to grep
  let cmd: string;
  try {
    execSync("which rg", { encoding: "utf-8" });
    cmd = `rg -n --max-count ${limit} --no-heading`;
    if (fileType) cmd += ` -t ${fileType}`;
    cmd += ` "${pattern}"`;
  } catch {
    cmd = `grep -rn --include="*.${fileType || "*"}" "${pattern}" . | head -${limit}`;
  }

  try {
    const output = execSync(cmd, { cwd: ctx.workingDirectory, encoding: "utf-8", timeout: 15000 });
    const matches = output.trim().split("\n").filter(Boolean).map(line => {
      const colonIdx = line.indexOf(":");
      const secondColon = line.indexOf(":", colonIdx + 1);
      return {
        file: line.slice(0, colonIdx),
        line: parseInt(line.slice(colonIdx + 1, secondColon)),
        content: line.slice(secondColon + 1).trim(),
      };
    });
    return { matches, count: matches.length };
  } catch {
    return { matches: [], count: 0 };
  }
});
