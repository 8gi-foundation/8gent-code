/**
 * @8gent/github — Deep GitHub Integration
 *
 * Leverages the full GitHub ecosystem: Issues, PRs, Actions, Projects,
 * Gists, Releases, Branches, Repo management, Notifications, and Sync.
 *
 * All tools use the `gh` CLI for authentication and API access.
 * Prerequisite: `gh auth login` must have been run.
 *
 * ## Tool Categories
 *
 * | Category      | Tools | Description |
 * |---------------|-------|-------------|
 * | Issues        | 8     | Full lifecycle: view, comment, close, reopen, assign, label, search, create |
 * | Pull Requests | 9     | View, diff, files, review, comment, merge, checks, close, ready |
 * | Actions       | 8     | Workflows, runs, logs, trigger, re-run, cancel, artifacts |
 * | Projects v2   | 6     | List, view, items, add, edit, create |
 * | Gists         | 6     | List, view, create, edit, delete, clone |
 * | Releases      | 7     | List, view, create, edit, delete, upload, download |
 * | Branches      | 6     | Compare, list, delete, protection, merge, stale detection |
 * | Repo          | 10    | Info, contributors, labels, milestones, code search, repo search, notifications, fork, clone |
 * | Sync          | 4     | Fork sync, fetch all, health check, triage dashboard |
 *
 * ## Usage
 *
 * ```typescript
 * // Import to register all tools with the toolshed
 * import "@8gent/github";
 *
 * // Or import the client directly
 * import { getGitHubClient } from "@8gent/github/client";
 * const client = getGitHubClient({ cwd: process.cwd() });
 * ```
 */

// Register all GitHub tools with the toolshed
import "./tools/issues";
import "./tools/pull-requests";
import "./tools/actions";
import "./tools/projects";
import "./tools/gists";
import "./tools/releases";
import "./tools/branches";
import "./tools/repo";
import "./tools/sync";

// Re-export the client for direct usage
export { GitHubClient, getGitHubClient } from "./client";
export type { GitHubClientOptions, GitHubError } from "./client";
