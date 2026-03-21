/**
 * Publish Actuators
 *
 * Release code: npm publish, git tags, GitHub releases.
 * All use Bun.spawn for CLI. All respect dryRun.
 */

import { type ActuatorConfig, type ActuatorResult, ok, fail, checkTarget, log } from "./types";

/** Run a CLI command via Bun.spawn, capture stdout + stderr */
async function exec(
  cmd: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

/**
 * Publish package to npm (runs `npm publish`)
 *
 * Requires: npm authenticated (`npm whoami` works).
 * Reversible: yes within 72 hours via `npm unpublish`.
 */
export async function npmPublish(
  packageDir: string,
  config: ActuatorConfig,
): Promise<ActuatorResult> {
  const action = "publish:npm";
  const target = packageDir;

  const blocked = checkTarget(target, config);
  if (blocked) return fail(action, target, blocked);

  log(action, target, config.dryRun, "npm publish");

  if (config.dryRun) {
    // npm publish --dry-run actually validates the package without publishing
    const result = await exec(["npm", "publish", "--dry-run"], packageDir);
    return ok(action, target, `DRY RUN:\n${result.stdout}`, {
      reversible: true,
      undoCommand: `cd ${packageDir} && npm unpublish <pkg>@<version>`,
    });
  }

  const result = await exec(["npm", "publish"], packageDir);

  if (result.exitCode !== 0) {
    return fail(action, target, `Exit ${result.exitCode}: ${result.stderr || result.stdout}`);
  }

  return ok(action, target, result.stdout, {
    reversible: true,
    undoCommand: `cd ${packageDir} && npm unpublish <pkg>@<version>`,
  });
}

/**
 * Create a git tag and push it to origin
 *
 * Reversible: yes — delete remote tag with `git push origin :refs/tags/<tag>`.
 */
export async function gitTagAndPush(
  dir: string,
  tag: string,
  config: ActuatorConfig,
): Promise<ActuatorResult> {
  const action = "publish:git-tag";
  const target = `${dir}#${tag}`;

  const blocked = checkTarget(dir, config);
  if (blocked) return fail(action, target, blocked);

  log(action, target, config.dryRun, `git tag ${tag} && git push origin ${tag}`);

  if (config.dryRun) {
    return ok(action, target, `DRY RUN: would create tag "${tag}" and push to origin`, {
      reversible: true,
      undoCommand: `cd ${dir} && git tag -d ${tag} && git push origin :refs/tags/${tag}`,
    });
  }

  // Create tag
  const tagResult = await exec(["git", "tag", tag], dir);
  if (tagResult.exitCode !== 0) {
    return fail(action, target, `Failed to create tag: ${tagResult.stderr}`);
  }

  // Push tag
  const pushResult = await exec(["git", "push", "origin", tag], dir);
  if (pushResult.exitCode !== 0) {
    // Rollback local tag on push failure
    await exec(["git", "tag", "-d", tag], dir);
    return fail(action, target, `Tag created but push failed: ${pushResult.stderr}`);
  }

  return ok(action, target, `Tagged and pushed ${tag}`, {
    reversible: true,
    undoCommand: `cd ${dir} && git tag -d ${tag} && git push origin :refs/tags/${tag}`,
  });
}

/**
 * Create a GitHub release (uses `gh release create`)
 *
 * Requires: `gh` CLI authenticated.
 * Reversible: yes — `gh release delete <tag>`.
 */
export async function createGitHubRelease(
  repo: string,
  tag: string,
  notes: string,
  config: ActuatorConfig,
): Promise<ActuatorResult> {
  const action = "publish:github-release";
  const target = `${repo}@${tag}`;

  const blocked = checkTarget(repo, config);
  if (blocked) return fail(action, target, blocked);

  log(action, target, config.dryRun, `gh release create ${tag}`);

  if (config.dryRun) {
    return ok(action, target, `DRY RUN: would create GitHub release "${tag}" on ${repo}\nNotes: ${notes}`, {
      reversible: true,
      undoCommand: `gh release delete ${tag} --repo ${repo} --yes`,
    });
  }

  const result = await exec(
    ["gh", "release", "create", tag, "--repo", repo, "--title", tag, "--notes", notes],
    process.cwd(),
  );

  if (result.exitCode !== 0) {
    return fail(action, target, `Exit ${result.exitCode}: ${result.stderr || result.stdout}`);
  }

  return ok(action, target, result.stdout, {
    reversible: true,
    undoCommand: `gh release delete ${tag} --repo ${repo} --yes`,
  });
}
