/**
 * @8gent/github — GitHub CLI Client
 *
 * Wraps the `gh` CLI for structured, type-safe GitHub API access.
 * Uses `gh api` for REST/GraphQL calls when `gh` subcommands don't suffice.
 *
 * Why `gh` CLI instead of raw REST?
 * - Already authenticated (gh auth login)
 * - Handles pagination, rate limiting, token refresh
 * - Works with GitHub Enterprise out of the box
 * - No extra dependencies
 */

import { execSync, type ExecSyncOptions } from "child_process";

// ── Types ──────────────────────────────────────────────────

export interface GitHubClientOptions {
  cwd?: string;
  timeout?: number;
}

export interface GitHubError {
  command: string;
  stderr: string;
  exitCode: number | null;
}

// ── Client ─────────────────────────────────────────────────

export class GitHubClient {
  private cwd: string;
  private timeout: number;

  constructor(opts: GitHubClientOptions = {}) {
    this.cwd = opts.cwd || process.cwd();
    this.timeout = opts.timeout || 30_000;
  }

  /** Run a `gh` command and return raw string output. */
  exec(args: string): string {
    const cmd = `gh ${args}`;
    try {
      return execSync(cmd, {
        cwd: this.cwd,
        encoding: "utf-8",
        timeout: this.timeout,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    } catch (err: any) {
      const stderr = err.stderr?.trim() || err.message;
      throw Object.assign(new Error(`gh command failed: ${stderr}`), {
        command: cmd,
        stderr,
        exitCode: err.status,
      } satisfies GitHubError);
    }
  }

  /** Run a `gh` command and parse JSON output. */
  json<T = unknown>(args: string): T {
    const raw = this.exec(args);
    return JSON.parse(raw || "null") as T;
  }

  /** Call the GitHub REST API via `gh api`. */
  api<T = unknown>(endpoint: string, opts?: {
    method?: string;
    fields?: Record<string, string | number | boolean>;
    jq?: string;
  }): T {
    let cmd = `api ${endpoint}`;
    if (opts?.method) cmd += ` --method ${opts.method}`;
    if (opts?.fields) {
      for (const [k, v] of Object.entries(opts.fields)) {
        cmd += ` -f ${k}=${JSON.stringify(String(v))}`;
      }
    }
    if (opts?.jq) cmd += ` --jq '${opts.jq}'`;
    return this.json<T>(cmd);
  }

  /** Call the GitHub GraphQL API via `gh api graphql`. */
  graphql<T = unknown>(query: string, variables?: Record<string, unknown>): T {
    let cmd = `api graphql -f query='${query.replace(/'/g, "'\\''")}'`;
    if (variables) {
      for (const [k, v] of Object.entries(variables)) {
        cmd += ` -f ${k}=${JSON.stringify(String(v))}`;
      }
    }
    return this.json<T>(cmd);
  }

  /** Check if `gh` is authenticated. */
  isAuthenticated(): boolean {
    try {
      this.exec("auth status");
      return true;
    } catch {
      return false;
    }
  }

  /** Get current repo owner/name. */
  getRepo(): { owner: string; name: string; full: string } | null {
    try {
      const raw = this.exec("repo view --json owner,name");
      const parsed = JSON.parse(raw);
      return {
        owner: parsed.owner?.login || parsed.owner,
        name: parsed.name,
        full: `${parsed.owner?.login || parsed.owner}/${parsed.name}`,
      };
    } catch {
      return null;
    }
  }

  /** Update the working directory. */
  setCwd(cwd: string): void {
    this.cwd = cwd;
  }
}

// ── Singleton ──────────────────────────────────────────────

let _client: GitHubClient | null = null;

export function getGitHubClient(opts?: GitHubClientOptions): GitHubClient {
  if (!_client) {
    _client = new GitHubClient(opts);
  } else if (opts?.cwd) {
    _client.setCwd(opts.cwd);
  }
  return _client;
}
