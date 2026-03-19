/**
 * 8gent Toolshed - GitHub Workflow Automation
 *
 * OpenViktor-inspired workflow automation for git operations:
 * auto-commit, branching, merging, fork sync, changelog, and archival.
 */

import { execSync } from "child_process";

function run(cmd: string, cwd?: string): string {
  try {
    return execSync(cmd, {
      cwd: cwd || process.cwd(),
      encoding: "utf-8",
      timeout: 30000,
    }).trim();
  } catch (err: any) {
    throw new Error(err.stderr?.trim() || err.message);
  }
}

export class GitHubWorkflow {
  private cwd: string;

  constructor(workingDirectory?: string) {
    this.cwd = workingDirectory || process.cwd();
  }

  private exec(cmd: string): string {
    return run(cmd, this.cwd);
  }

  /**
   * Stage all changes, commit, and push to remote.
   * Automatically sets upstream tracking on first push.
   */
  async autoCommitAndPush(
    message: string,
    branch?: string
  ): Promise<{ commitHash: string; pushed: boolean }> {
    // Switch branch if specified
    if (branch) {
      const currentBranch = this.exec("git rev-parse --abbrev-ref HEAD");
      if (currentBranch !== branch) {
        try {
          this.exec(`git checkout ${branch}`);
        } catch {
          this.exec(`git checkout -b ${branch}`);
        }
      }
    }

    // Stage all changes
    this.exec("git add -A");

    // Check if there's anything to commit
    const status = this.exec("git status --porcelain");
    if (!status) {
      return { commitHash: this.exec("git rev-parse --short HEAD"), pushed: false };
    }

    // Commit
    const escapedMessage = message.replace(/"/g, '\\"');
    this.exec(`git commit -m "${escapedMessage}"`);
    const commitHash = this.exec("git rev-parse --short HEAD");

    // Push
    let pushed = false;
    try {
      this.exec("git push");
      pushed = true;
    } catch {
      // No upstream set — push with -u
      const currentBranch = this.exec("git rev-parse --abbrev-ref HEAD");
      try {
        this.exec(`git push -u origin ${currentBranch}`);
        pushed = true;
      } catch {
        pushed = false;
      }
    }

    return { commitHash, pushed };
  }

  /**
   * Create a new feature branch from a base branch.
   * Returns the full branch name.
   */
  async createFeatureBranch(
    name: string,
    baseBranch?: string
  ): Promise<string> {
    const base = baseBranch || this.exec("git symbolic-ref refs/remotes/origin/HEAD --short").replace("origin/", "");

    // Fetch latest
    try {
      this.exec("git fetch origin");
    } catch {
      // Offline — continue with local state
    }

    // Create and switch to the new branch
    const branchName = name.startsWith("feature/") ? name : `feature/${name}`;
    this.exec(`git checkout -b ${branchName} origin/${base}`);

    return branchName;
  }

  /**
   * Merge a source branch into a target branch.
   * Supports merge, rebase, and squash strategies.
   */
  async mergeBranch(
    source: string,
    target: string,
    strategy: "merge" | "rebase" | "squash" = "merge"
  ): Promise<boolean> {
    const originalBranch = this.exec("git rev-parse --abbrev-ref HEAD");

    try {
      this.exec(`git checkout ${target}`);
      this.exec("git pull --ff-only origin " + target).catch(() => {});

      switch (strategy) {
        case "merge":
          this.exec(`git merge ${source} --no-edit`);
          break;
        case "rebase":
          this.exec(`git rebase ${source}`);
          break;
        case "squash":
          this.exec(`git merge --squash ${source}`);
          this.exec(`git commit -m "squash: merge ${source} into ${target}" --no-edit`);
          break;
      }

      return true;
    } catch (err) {
      // Abort any in-progress merge/rebase on failure
      try { this.exec("git merge --abort"); } catch {}
      try { this.exec("git rebase --abort"); } catch {}
      this.exec(`git checkout ${originalBranch}`);
      return false;
    }
  }

  /**
   * Sync a fork with its upstream remote.
   * Adds upstream remote if not already configured.
   */
  async syncFork(): Promise<void> {
    // Check if upstream exists
    const remotes = this.exec("git remote -v");
    if (!remotes.includes("upstream")) {
      // Get parent repo URL from GitHub
      const repoJson = this.exec("gh repo view --json parent");
      const { parent } = JSON.parse(repoJson);
      if (!parent) {
        throw new Error("This repository is not a fork");
      }
      this.exec(
        `git remote add upstream https://github.com/${parent.owner.login}/${parent.name}.git`
      );
    }

    // Fetch and merge upstream
    this.exec("git fetch upstream");
    const defaultBranch = this.exec(
      "git symbolic-ref refs/remotes/origin/HEAD --short"
    ).replace("origin/", "");
    this.exec(`git checkout ${defaultBranch}`);
    this.exec(`git merge upstream/${defaultBranch} --no-edit`);
    this.exec(`git push origin ${defaultBranch}`);
  }

  /**
   * Generate a changelog from git log since a given date or tag.
   * Groups commits by conventional commit type.
   */
  async getChangelog(since: string): Promise<string> {
    const log = this.exec(
      `git log --oneline --format="%s" --since="${since}"`
    );

    if (!log) return "_No commits since " + since + "_";

    const commits = log.split("\n").filter(Boolean);

    const groups: Record<string, string[]> = {
      feat: [],
      fix: [],
      refactor: [],
      docs: [],
      test: [],
      chore: [],
      other: [],
    };

    for (const msg of commits) {
      const match = msg.match(/^(\w+)(?:\(.+?\))?:\s*(.+)$/);
      if (match) {
        const type = match[1].toLowerCase();
        const description = match[2];
        if (type in groups) {
          groups[type].push(description);
        } else {
          groups.other.push(msg);
        }
      } else {
        groups.other.push(msg);
      }
    }

    const sectionNames: Record<string, string> = {
      feat: "Features",
      fix: "Bug Fixes",
      refactor: "Refactoring",
      docs: "Documentation",
      test: "Tests",
      chore: "Chores",
      other: "Other",
    };

    const sections = Object.entries(groups)
      .filter(([, items]) => items.length > 0)
      .map(([type, items]) => {
        const heading = sectionNames[type] || type;
        const list = items.map((i) => `- ${i}`).join("\n");
        return `### ${heading}\n${list}`;
      })
      .join("\n\n");

    return `# Changelog (since ${since})\n\n${sections}`;
  }

  /**
   * Archive a branch by creating a tag and deleting it.
   * The tag preserves the branch's final state for future reference.
   */
  async archiveBranch(branch: string): Promise<void> {
    const currentBranch = this.exec("git rev-parse --abbrev-ref HEAD");

    if (currentBranch === branch) {
      throw new Error(
        `Cannot archive the currently checked-out branch (${branch}). Switch to another branch first.`
      );
    }

    const timestamp = new Date().toISOString().split("T")[0];
    const tagName = `archive/${branch}/${timestamp}`;

    // Create archive tag at the branch tip
    this.exec(`git tag ${tagName} ${branch}`);

    // Push the tag
    try {
      this.exec(`git push origin ${tagName}`);
    } catch {
      // Offline — tag is local only
    }

    // Delete the branch locally and remotely
    this.exec(`git branch -D ${branch}`);
    try {
      this.exec(`git push origin --delete ${branch}`);
    } catch {
      // Branch might not exist on remote
    }
  }
}
