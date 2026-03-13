/**
 * Mock filesystem for CB001 — Git Repository Analyzer benchmark.
 *
 * Simulates a directory tree with 5 git repos:
 * 1. /repos/webapp — active JS project, 50 commits
 * 2. /repos/api-server — Go project, 120 commits
 * 3. /repos/empty-project — initialized but no commits
 * 4. /repos/api-server/vendor/lib — nested git repo (submodule — should be SKIPPED)
 * 5. /repos/legacy — detached HEAD, 15 commits, mostly binary
 */

export interface MockStat {
  isDirectory: boolean;
  isFile: boolean;
  size: number;
}

export interface MockDirEntry {
  name: string;
  isDirectory: boolean;
}

// Generate commit log entries
function makeCommitLog(
  commits: Array<{
    hash: string;
    author: string;
    email: string;
    date: string;
    message: string;
  }>
): string {
  return commits
    .map(
      (c) =>
        `commit ${c.hash}\nAuthor: ${c.author} <${c.email}>\nDate:   ${c.date}\n\n    ${c.message}\n`
    )
    .join("\n");
}

const WEBAPP_COMMITS = Array.from({ length: 50 }, (_, i) => ({
  hash: `a${String(i).padStart(39, "0")}`,
  author: i % 3 === 0 ? "Alice" : i % 3 === 1 ? "Bob" : "Carol",
  email:
    i % 3 === 0
      ? "alice@dev.com"
      : i % 3 === 1
      ? "bob@dev.com"
      : "carol@dev.com",
  date: `Mon Jan ${(i % 28) + 1} 10:${String(i % 60).padStart(2, "0")}:00 2024 +0000`,
  message: `feat: update component ${i}`,
}));

const API_COMMITS = Array.from({ length: 120 }, (_, i) => ({
  hash: `b${String(i).padStart(39, "0")}`,
  author: i % 2 === 0 ? "Dave" : "Eve",
  email: i % 2 === 0 ? "dave@api.com" : "eve@api.com",
  // Concentrate commits on Tuesdays and Fridays
  date: `${i % 2 === 0 ? "Tue" : "Fri"} Feb ${(i % 28) + 1} 14:${String(i % 60).padStart(2, "0")}:00 2024 +0000`,
  message: `fix: endpoint handler ${i}`,
}));

const LEGACY_COMMITS = Array.from({ length: 15 }, (_, i) => ({
  hash: `c${String(i).padStart(39, "0")}`,
  author: "Frank",
  email: "frank@old.com",
  date: `Wed Mar ${(i % 28) + 1} 09:${String(i % 60).padStart(2, "0")}:00 2023 +0000`,
  message: `chore: legacy update ${i}`,
}));

const SUBMODULE_COMMITS = Array.from({ length: 5 }, (_, i) => ({
  hash: `d${String(i).padStart(39, "0")}`,
  author: "Vendor",
  email: "vendor@lib.com",
  date: `Thu Apr ${(i % 28) + 1} 12:00:00 2024 +0000`,
  message: `release: v1.${i}`,
}));

// File tree structure
const FILE_TREE: Record<string, MockDirEntry[]> = {
  "/repos": [
    { name: "webapp", isDirectory: true },
    { name: "api-server", isDirectory: true },
    { name: "empty-project", isDirectory: true },
    { name: "legacy", isDirectory: true },
    { name: "readme.txt", isDirectory: false },
  ],
  "/repos/webapp": [
    { name: ".git", isDirectory: true },
    { name: "src", isDirectory: true },
    { name: "package.json", isDirectory: false },
    { name: "tsconfig.json", isDirectory: false },
  ],
  "/repos/webapp/.git": [
    { name: "HEAD", isDirectory: false },
    { name: "config", isDirectory: false },
  ],
  "/repos/webapp/src": [
    { name: "index.ts", isDirectory: false },
    { name: "app.tsx", isDirectory: false },
    { name: "utils.ts", isDirectory: false },
    { name: "styles.css", isDirectory: false },
  ],
  "/repos/api-server": [
    { name: ".git", isDirectory: true },
    { name: "cmd", isDirectory: true },
    { name: "internal", isDirectory: true },
    { name: "vendor", isDirectory: true },
    { name: "go.mod", isDirectory: false },
    { name: "go.sum", isDirectory: false },
    { name: "Makefile", isDirectory: false },
  ],
  "/repos/api-server/.git": [
    { name: "HEAD", isDirectory: false },
    { name: "config", isDirectory: false },
  ],
  "/repos/api-server/cmd": [
    { name: "main.go", isDirectory: false },
    { name: "server.go", isDirectory: false },
  ],
  "/repos/api-server/internal": [
    { name: "handler.go", isDirectory: false },
    { name: "middleware.go", isDirectory: false },
    { name: "models.go", isDirectory: false },
  ],
  "/repos/api-server/vendor": [
    { name: "lib", isDirectory: true },
  ],
  "/repos/api-server/vendor/lib": [
    { name: ".git", isDirectory: true }, // submodule!
    { name: "lib.go", isDirectory: false },
  ],
  "/repos/api-server/vendor/lib/.git": [
    { name: "HEAD", isDirectory: false },
  ],
  "/repos/empty-project": [
    { name: ".git", isDirectory: true },
  ],
  "/repos/empty-project/.git": [
    { name: "HEAD", isDirectory: false },
  ],
  "/repos/legacy": [
    { name: ".git", isDirectory: true },
    { name: "data.bin", isDirectory: false },
    { name: "model.pkl", isDirectory: false },
    { name: "script.py", isDirectory: false },
    { name: "README.md", isDirectory: false },
  ],
  "/repos/legacy/.git": [
    { name: "HEAD", isDirectory: false },
  ],
};

const FILE_STATS: Record<string, MockStat> = {
  "/repos/readme.txt": { isDirectory: false, isFile: true, size: 256 },
  "/repos/webapp/package.json": { isDirectory: false, isFile: true, size: 1024 },
  "/repos/webapp/tsconfig.json": { isDirectory: false, isFile: true, size: 512 },
  "/repos/webapp/src/index.ts": { isDirectory: false, isFile: true, size: 2048 },
  "/repos/webapp/src/app.tsx": { isDirectory: false, isFile: true, size: 8192 },
  "/repos/webapp/src/utils.ts": { isDirectory: false, isFile: true, size: 4096 },
  "/repos/webapp/src/styles.css": { isDirectory: false, isFile: true, size: 3072 },
  "/repos/api-server/go.mod": { isDirectory: false, isFile: true, size: 256 },
  "/repos/api-server/go.sum": { isDirectory: false, isFile: true, size: 16384 },
  "/repos/api-server/Makefile": { isDirectory: false, isFile: true, size: 512 },
  "/repos/api-server/cmd/main.go": { isDirectory: false, isFile: true, size: 1024 },
  "/repos/api-server/cmd/server.go": { isDirectory: false, isFile: true, size: 6144 },
  "/repos/api-server/internal/handler.go": { isDirectory: false, isFile: true, size: 12288 },
  "/repos/api-server/internal/middleware.go": { isDirectory: false, isFile: true, size: 4096 },
  "/repos/api-server/internal/models.go": { isDirectory: false, isFile: true, size: 3072 },
  "/repos/api-server/vendor/lib/lib.go": { isDirectory: false, isFile: true, size: 2048 },
  "/repos/legacy/data.bin": { isDirectory: false, isFile: true, size: 1048576 }, // 1MB binary
  "/repos/legacy/model.pkl": { isDirectory: false, isFile: true, size: 524288 }, // 512KB binary
  "/repos/legacy/script.py": { isDirectory: false, isFile: true, size: 1536 },
  "/repos/legacy/README.md": { isDirectory: false, isFile: true, size: 768 },
};

const FILE_CONTENTS: Record<string, string> = {
  "/repos/webapp/.git/HEAD": "ref: refs/heads/main\n",
  "/repos/api-server/.git/HEAD": "ref: refs/heads/develop\n",
  "/repos/api-server/vendor/lib/.git/HEAD": "ref: refs/heads/main\n",
  "/repos/empty-project/.git/HEAD": "ref: refs/heads/main\n",
  "/repos/legacy/.git/HEAD": "c00000000000000000000000000000000000000\n", // detached HEAD
};

const GIT_LOGS: Record<string, string> = {
  "/repos/webapp": makeCommitLog(WEBAPP_COMMITS),
  "/repos/api-server": makeCommitLog(API_COMMITS),
  "/repos/empty-project": "", // no commits
  "/repos/api-server/vendor/lib": makeCommitLog(SUBMODULE_COMMITS),
  "/repos/legacy": makeCommitLog(LEGACY_COMMITS),
};

/**
 * Mock filesystem class for testing.
 * The LLM must use this instead of real fs calls.
 */
export class MockFileSystem {
  async readdir(path: string): Promise<MockDirEntry[]> {
    const normalized = path.replace(/\/+$/, "");
    const entries = FILE_TREE[normalized];
    if (!entries) throw new Error(`ENOENT: no such directory: ${path}`);
    return [...entries];
  }

  async stat(path: string): Promise<MockStat> {
    const normalized = path.replace(/\/+$/, "");
    // Check if it's a known directory
    if (FILE_TREE[normalized]) {
      return { isDirectory: true, isFile: false, size: 0 };
    }
    const s = FILE_STATS[normalized];
    if (!s) throw new Error(`ENOENT: no such file: ${path}`);
    return { ...s };
  }

  async readFile(path: string): Promise<string> {
    const normalized = path.replace(/\/+$/, "");
    const content = FILE_CONTENTS[normalized];
    if (content !== undefined) return content;
    throw new Error(`ENOENT: no such file: ${path}`);
  }

  /**
   * Simulate `git log` output for a repo path.
   * Pass the repo root (directory containing .git), not the .git dir itself.
   */
  async gitLog(repoPath: string): Promise<string> {
    const normalized = repoPath.replace(/\/+$/, "");
    const log = GIT_LOGS[normalized];
    if (log === undefined) throw new Error(`Not a git repository: ${repoPath}`);
    return log;
  }

  /**
   * Simulate `git rev-parse --show-toplevel` for a path.
   */
  async gitRoot(path: string): Promise<string> {
    const normalized = path.replace(/\/+$/, "");
    for (const repoPath of Object.keys(GIT_LOGS)) {
      if (normalized === repoPath || normalized.startsWith(repoPath + "/")) {
        return repoPath;
      }
    }
    throw new Error(`Not inside a git repository: ${path}`);
  }
}

/**
 * Expected results for verification:
 *
 * Repos found (excluding submodule): webapp, api-server, empty-project, legacy = 4
 *
 * webapp: 50 commits, 3 authors (Alice, Bob, Carol), largest file: app.tsx (8192)
 *   Language breakdown: .ts=2, .tsx=1, .css=1, .json=2 → TS-heavy
 *
 * api-server: 120 commits, 2 authors (Dave, Eve), largest file: handler.go (12288)
 *   Language breakdown: .go=5 (excluding vendor), .mod=1, .sum=1
 *
 * empty-project: 0 commits, 0 authors
 *
 * legacy: 15 commits, 1 author (Frank), largest file: data.bin (1048576)
 *   Language breakdown: .bin=1, .pkl=1, .py=1, .md=1 → mostly binary
 *   Detached HEAD (no branch name)
 *
 * Sorted by commits desc: api-server(120), webapp(50), legacy(15), empty-project(0)
 */
export const EXPECTED = {
  repoCount: 4,
  repos: {
    webapp: { commits: 50, authors: 3, largestFile: "app.tsx", largestSize: 8192 },
    "api-server": { commits: 120, authors: 2, largestFile: "handler.go", largestSize: 12288 },
    "empty-project": { commits: 0, authors: 0 },
    legacy: { commits: 15, authors: 1, largestFile: "data.bin", largestSize: 1048576, detachedHead: true },
  },
  sortOrder: ["api-server", "webapp", "legacy", "empty-project"],
};
