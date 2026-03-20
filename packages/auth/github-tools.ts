/**
 * @8gent/auth — GitHub API Tools
 *
 * Helper functions for common GitHub operations using the provider token.
 * Uses fetch directly against the GitHub REST API (not the gh CLI).
 */

import * as fs from "fs";
import * as path from "path";

// ============================================
// Types
// ============================================

export interface GitHubRepo {
  name: string;
  fullName: string;
  url: string;
  isPrivate: boolean;
}

export interface GitHubIssue {
  number: number;
  title: string;
  labels: string[];
}

export interface GitHubPR {
  number: number;
  url: string;
}

export interface RepoInfo {
  owner: string;
  repo: string;
  remote: string;
}

// ============================================
// Shared Headers
// ============================================

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

// ============================================
// Repository Operations
// ============================================

/**
 * List repos the authenticated user has access to.
 * Returns up to 100 repos sorted by most recently pushed.
 */
export async function listRepos(
  token: string,
  opts?: { perPage?: number; sort?: "pushed" | "updated" | "created" },
): Promise<GitHubRepo[]> {
  const perPage = opts?.perPage ?? 30;
  const sort = opts?.sort ?? "pushed";

  const resp = await fetch(
    `https://api.github.com/user/repos?per_page=${perPage}&sort=${sort}&direction=desc`,
    { headers: githubHeaders(token) },
  );

  if (!resp.ok) return [];

  const data = (await resp.json()) as Array<Record<string, unknown>>;
  return data.map((r) => ({
    name: r.name as string,
    fullName: r.full_name as string,
    url: r.html_url as string,
    isPrivate: r.private as boolean,
  }));
}

// ============================================
// Current Repo Detection
// ============================================

/**
 * Get the current directory's GitHub repo info by reading .git/config.
 * Parses the remote URL to extract owner and repo name.
 *
 * @param cwd - Working directory (defaults to process.cwd())
 */
export async function getCurrentRepoInfo(cwd?: string): Promise<RepoInfo | null> {
  const dir = cwd ?? process.cwd();

  // Find .git/config
  const gitConfigPath = path.join(dir, ".git", "config");
  if (!fs.existsSync(gitConfigPath)) return null;

  try {
    const config = fs.readFileSync(gitConfigPath, "utf-8");

    // Parse remote "origin" URL
    const remoteMatch = config.match(
      /\[remote "origin"\][^[]*url\s*=\s*(.+)/m,
    );
    if (!remoteMatch) return null;

    const remoteUrl = remoteMatch[1].trim();
    return parseGitHubRemote(remoteUrl);
  } catch {
    return null;
  }
}

/**
 * Parse a GitHub remote URL into owner/repo.
 * Supports HTTPS, SSH, and git:// formats.
 */
function parseGitHubRemote(url: string): RepoInfo | null {
  // HTTPS: https://github.com/owner/repo.git
  const httpsMatch = url.match(
    /https?:\/\/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?/,
  );
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2], remote: url };
  }

  // SSH: git@github.com:owner/repo.git
  const sshMatch = url.match(
    /git@github\.com:([^/]+)\/([^/.]+)(?:\.git)?/,
  );
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2], remote: url };
  }

  // git://github.com/owner/repo.git
  const gitMatch = url.match(
    /git:\/\/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?/,
  );
  if (gitMatch) {
    return { owner: gitMatch[1], repo: gitMatch[2], remote: url };
  }

  return null;
}

// ============================================
// Issues
// ============================================

/**
 * List open issues for a repository.
 */
export async function listIssues(
  token: string,
  owner: string,
  repo: string,
  opts?: { state?: "open" | "closed" | "all"; perPage?: number },
): Promise<GitHubIssue[]> {
  const state = opts?.state ?? "open";
  const perPage = opts?.perPage ?? 30;

  const resp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues?state=${state}&per_page=${perPage}`,
    { headers: githubHeaders(token) },
  );

  if (!resp.ok) return [];

  const data = (await resp.json()) as Array<Record<string, unknown>>;

  // GitHub API returns PRs as issues too — filter them out
  return data
    .filter((i) => !i.pull_request)
    .map((i) => ({
      number: i.number as number,
      title: i.title as string,
      labels: ((i.labels as Array<Record<string, unknown>>) || []).map(
        (l) => (typeof l === "string" ? l : (l.name as string)) || "",
      ),
    }));
}

/**
 * Create an issue in a repository.
 */
export async function createIssue(
  token: string,
  owner: string,
  repo: string,
  title: string,
  body: string,
): Promise<{ number: number; url: string } | null> {
  const resp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues`,
    {
      method: "POST",
      headers: {
        ...githubHeaders(token),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title, body }),
    },
  );

  if (!resp.ok) return null;

  const data = (await resp.json()) as Record<string, unknown>;
  return {
    number: data.number as number,
    url: data.html_url as string,
  };
}

// ============================================
// Pull Requests
// ============================================

/**
 * Create a pull request.
 */
export async function createPR(
  token: string,
  owner: string,
  repo: string,
  opts: { title: string; body: string; head: string; base: string },
): Promise<GitHubPR | null> {
  const resp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls`,
    {
      method: "POST",
      headers: {
        ...githubHeaders(token),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: opts.title,
        body: opts.body,
        head: opts.head,
        base: opts.base,
      }),
    },
  );

  if (!resp.ok) return null;

  const data = (await resp.json()) as Record<string, unknown>;
  return {
    number: data.number as number,
    url: data.html_url as string,
  };
}

/**
 * List open pull requests.
 */
export async function listPRs(
  token: string,
  owner: string,
  repo: string,
  opts?: { state?: "open" | "closed" | "all"; perPage?: number },
): Promise<Array<{ number: number; title: string; url: string; head: string; base: string }>> {
  const state = opts?.state ?? "open";
  const perPage = opts?.perPage ?? 30;

  const resp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls?state=${state}&per_page=${perPage}`,
    { headers: githubHeaders(token) },
  );

  if (!resp.ok) return [];

  const data = (await resp.json()) as Array<Record<string, unknown>>;
  return data.map((pr) => ({
    number: pr.number as number,
    title: pr.title as string,
    url: pr.html_url as string,
    head: ((pr.head as Record<string, unknown>)?.ref as string) || "",
    base: ((pr.base as Record<string, unknown>)?.ref as string) || "",
  }));
}

/**
 * Get the current git branch name.
 */
export async function getCurrentBranch(cwd?: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: cwd ?? process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Get the default branch for a repo (usually main or master).
 */
export async function getDefaultBranch(
  token: string,
  owner: string,
  repo: string,
): Promise<string> {
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}`,
      { headers: githubHeaders(token) },
    );
    if (!resp.ok) return "main";
    const data = (await resp.json()) as Record<string, unknown>;
    return (data.default_branch as string) || "main";
  } catch {
    return "main";
  }
}
