/**
 * File Tree Visualizer for 8gent
 *
 * ASCII tree visualization with depth limits, ignore patterns,
 * file sizes, and color-coded output by file type.
 * Zero external dependencies - uses Bun.file and fs APIs.
 */

import { readdirSync, statSync, existsSync } from "fs";
import { join, extname, basename } from "path";

// --- Types ---

export interface FileTreeOptions {
  /** Max depth to traverse. Default: 4. Use 0 for unlimited. */
  depth?: number;
  /** Glob-style patterns to ignore. Supports * and ** wildcards. */
  ignore?: string[];
  /** Show file sizes. Default: true. */
  showSizes?: boolean;
  /** Colorize output with ANSI codes. Default: true when TTY. */
  color?: boolean;
  /** Show hidden files (starting with dot). Default: false. */
  showHidden?: boolean;
  /** Max files to show per directory. 0 = unlimited. Default: 0. */
  maxPerDir?: number;
}

export interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  ext: string;
  children?: TreeNode[];
  truncated?: number;
}

export interface TreeResult {
  root: string;
  tree: string;
  nodes: TreeNode;
  totalFiles: number;
  totalDirs: number;
  totalSize: number;
}

// --- ANSI color codes ---

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

const COLORS: Record<string, string> = {
  dir: "\x1b[34m",
  ts: "\x1b[36m",
  tsx: "\x1b[36m",
  js: "\x1b[33m",
  jsx: "\x1b[33m",
  mjs: "\x1b[33m",
  cjs: "\x1b[33m",
  html: "\x1b[35m",
  css: "\x1b[35m",
  scss: "\x1b[35m",
  json: "\x1b[32m",
  yaml: "\x1b[32m",
  yml: "\x1b[32m",
  toml: "\x1b[32m",
  env: "\x1b[32m",
  md: "\x1b[37m",
  txt: "\x1b[37m",
  sh: "\x1b[31m",
  bash: "\x1b[31m",
  zsh: "\x1b[31m",
  rs: "\x1b[31m",
  go: "\x1b[34m",
  py: "\x1b[33m",
  png: "\x1b[95m",
  jpg: "\x1b[95m",
  jpeg: "\x1b[95m",
  gif: "\x1b[95m",
  svg: "\x1b[95m",
  mp4: "\x1b[95m",
  webm: "\x1b[95m",
  default: "\x1b[0m",
};

function colorFor(node: TreeNode, useColor: boolean): string {
  if (!useColor) return "";
  if (node.isDir) return BOLD + COLORS.dir;
  return COLORS[node.ext] ?? COLORS.default;
}

// --- Ignore pattern matching ---

const DEFAULT_IGNORE = [
  "node_modules",
  ".git",
  ".DS_Store",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
  "__pycache__",
  "*.pyc",
  ".cache",
];

function matchesPattern(name: string, pattern: string): boolean {
  if (pattern === name) return true;
  if (pattern.startsWith("*.")) return name.endsWith(pattern.slice(1));
  if (pattern.endsWith("*")) return name.startsWith(pattern.slice(0, -1));
  if (pattern.startsWith("*")) return name.endsWith(pattern.slice(1));
  if (pattern === "**") return true;
  return false;
}

function shouldIgnore(name: string, ignorePatterns: string[]): boolean {
  return ignorePatterns.some((p) => matchesPattern(name, p));
}

// --- Size formatting ---

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`;
}

// --- Tree building ---

function buildNode(
  filePath: string,
  options: Required<FileTreeOptions>,
  currentDepth: number
): TreeNode | null {
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return null;
  }

  const name = basename(filePath);
  const isDir = stat.isDirectory();
  const ext = isDir ? "" : extname(name).slice(1).toLowerCase();
  const size = isDir ? 0 : stat.size;

  const node: TreeNode = { name, path: filePath, isDir, size, ext };

  if (isDir) {
    const maxDepth = options.depth;
    if (maxDepth > 0 && currentDepth >= maxDepth) {
      node.children = [];
      node.truncated = -1;
      return node;
    }

    let entries: string[];
    try {
      entries = readdirSync(filePath);
    } catch {
      node.children = [];
      return node;
    }

    let filtered = entries.filter((e) => {
      if (!options.showHidden && e.startsWith(".")) return false;
      if (shouldIgnore(e, options.ignore)) return false;
      return true;
    });

    filtered.sort((a, b) => {
      let aIsDir = false;
      let bIsDir = false;
      try { aIsDir = statSync(join(filePath, a)).isDirectory(); } catch {}
      try { bIsDir = statSync(join(filePath, b)).isDirectory(); } catch {}
      if (aIsDir && !bIsDir) return -1;
      if (!aIsDir && bIsDir) return 1;
      return a.localeCompare(b);
    });

    let truncated = 0;
    if (options.maxPerDir > 0 && filtered.length > options.maxPerDir) {
      truncated = filtered.length - options.maxPerDir;
      filtered = filtered.slice(0, options.maxPerDir);
    }

    const children: TreeNode[] = [];
    for (const entry of filtered) {
      const child = buildNode(join(filePath, entry), options, currentDepth + 1);
      if (child) children.push(child);
    }

    node.children = children;
    if (truncated > 0) node.truncated = truncated;
  }

  return node;
}

// --- ASCII rendering ---

const BRANCH = "├── ";
const LAST   = "└── ";
const VERT   = "│   ";
const SPACE  = "    ";

function renderNode(
  node: TreeNode,
  prefix: string,
  isLast: boolean,
  lines: string[],
  options: Required<FileTreeOptions>,
  stats: { files: number; dirs: number; totalSize: number }
): void {
  const connector = isLast ? LAST : BRANCH;
  const c = colorFor(node, options.color);
  const reset = options.color ? RESET : "";
  const dim = options.color ? DIM : "";

  let sizeStr = "";
  if (!node.isDir && options.showSizes) {
    sizeStr = ` ${dim}[${formatSize(node.size)}]${reset}`;
  }

  lines.push(`${prefix}${connector}${c}${node.name}${reset}${sizeStr}`);

  if (node.isDir) {
    stats.dirs++;
  } else {
    stats.files++;
    stats.totalSize += node.size;
  }

  if (node.children !== undefined) {
    const extension = isLast ? SPACE : VERT;
    const childPrefix = prefix + extension;

    if (node.truncated === -1) {
      lines.push(`${childPrefix}${dim}... (depth limit reached)${reset}`);
      return;
    }

    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      const isLastChild = i === node.children.length - 1 && !node.truncated;
      renderNode(child, childPrefix, isLastChild, lines, options, stats);
    }

    if (node.truncated && node.truncated > 0) {
      lines.push(`${childPrefix}${LAST}${dim}... ${node.truncated} more${reset}`);
    }
  }
}

// --- Public API ---

/**
 * Generate an ASCII file tree for the given root directory.
 *
 * @param root - Absolute or relative path to the root directory.
 * @param options - Optional configuration.
 * @returns TreeResult with rendered string and stats.
 */
export function generateTree(root: string, options: FileTreeOptions = {}): TreeResult {
  const isTTY = typeof process !== "undefined" && process.stdout?.isTTY === true;

  const opts: Required<FileTreeOptions> = {
    depth: options.depth ?? 4,
    ignore: [...DEFAULT_IGNORE, ...(options.ignore ?? [])],
    showSizes: options.showSizes ?? true,
    color: options.color ?? isTTY,
    showHidden: options.showHidden ?? false,
    maxPerDir: options.maxPerDir ?? 0,
  };

  if (!existsSync(root)) {
    throw new Error(`Path does not exist: ${root}`);
  }

  const rootNode = buildNode(root, opts, 0);
  if (!rootNode) {
    throw new Error(`Could not stat path: ${root}`);
  }

  const lines: string[] = [];
  const c = opts.color ? BOLD + COLORS.dir : "";
  const reset = opts.color ? RESET : "";
  lines.push(`${c}${rootNode.name}${reset}`);

  const stats = { files: 0, dirs: 0, totalSize: 0 };

  if (rootNode.children) {
    for (let i = 0; i < rootNode.children.length; i++) {
      const child = rootNode.children[i];
      const isLast = i === rootNode.children.length - 1 && !rootNode.truncated;
      renderNode(child, "", isLast, lines, opts, stats);
    }
    if (rootNode.truncated && rootNode.truncated > 0) {
      const dim = opts.color ? DIM : "";
      lines.push(`${LAST}${dim}... ${rootNode.truncated} more${reset}`);
    }
  }

  const dim = opts.color ? DIM : "";
  lines.push("");
  lines.push(`${dim}${stats.dirs} dirs, ${stats.files} files, ${formatSize(stats.totalSize)}${reset}`);

  return {
    root,
    tree: lines.join("\n"),
    nodes: rootNode,
    totalFiles: stats.files,
    totalDirs: stats.dirs,
    totalSize: stats.totalSize,
  };
}

// --- CLI entry point ---

if (import.meta.main) {
  const args = process.argv.slice(2);

  let root = ".";
  let depth = 4;
  let noColor = false;
  let showHidden = false;
  let noSizes = false;
  let maxPerDir = 0;
  const extraIgnore: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") {
      console.log(`
8gent file-tree - ASCII directory visualizer

Usage:
  bun packages/tools/file-tree.ts [path] [options]

Options:
  --depth, -d <n>       Max depth (default: 4, 0 = unlimited)
  --no-color            Disable ANSI colors
  --hidden              Show hidden files/dirs
  --no-sizes            Hide file sizes
  --max-per-dir <n>     Max entries per directory
  --ignore <pattern>    Extra ignore pattern (repeatable)
  --help, -h            Show this help

Examples:
  bun packages/tools/file-tree.ts
  bun packages/tools/file-tree.ts src --depth 3
  bun packages/tools/file-tree.ts . --depth 0 --no-color
  bun packages/tools/file-tree.ts . --ignore "*.test.ts" --max-per-dir 10
`);
      process.exit(0);
    } else if ((a === "--depth" || a === "-d") && args[i + 1]) {
      depth = parseInt(args[++i], 10);
    } else if (a === "--no-color") {
      noColor = true;
    } else if (a === "--hidden") {
      showHidden = true;
    } else if (a === "--no-sizes") {
      noSizes = true;
    } else if (a === "--max-per-dir" && args[i + 1]) {
      maxPerDir = parseInt(args[++i], 10);
    } else if (a === "--ignore" && args[i + 1]) {
      extraIgnore.push(args[++i]);
    } else if (!a.startsWith("--")) {
      root = a;
    }
  }

  try {
    const result = generateTree(root, {
      depth,
      color: !noColor,
      showHidden,
      showSizes: !noSizes,
      maxPerDir,
      ignore: extraIgnore,
    });
    console.log(result.tree);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    process.exit(1);
  }
}
