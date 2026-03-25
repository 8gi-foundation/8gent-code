/**
 * Deploy Actuators
 *
 * Push code to production via Vercel, Railway, or Fly.io.
 * All use Bun.spawn for CLI execution. All respect dryRun.
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
 * Deploy to Vercel (runs `vercel --prod --yes`)
 *
 * Requires: `vercel` CLI installed and linked to project.
 * Reversible: yes — Vercel keeps deployment history, rollback via dashboard or `vercel rollback`.
 */
export async function deployToVercel(
  projectDir: string,
  config: ActuatorConfig,
): Promise<ActuatorResult> {
  const action = "deploy:vercel";
  const target = projectDir;

  const blocked = checkTarget(target, config);
  if (blocked) return fail(action, target, blocked);

  log(action, target, config.dryRun, "vercel --prod --yes");

  if (config.dryRun) {
    return ok(action, target, "DRY RUN: would run `vercel --prod --yes`", {
      reversible: true,
      undoCommand: `cd ${projectDir} && vercel rollback`,
    });
  }

  const result = await exec(["vercel", "--prod", "--yes"], projectDir);

  if (result.exitCode !== 0) {
    return fail(action, target, `Exit ${result.exitCode}: ${result.stderr || result.stdout}`);
  }

  return ok(action, target, result.stdout, {
    reversible: true,
    undoCommand: `cd ${projectDir} && vercel rollback`,
  });
}

/**
 * Deploy to Railway (runs `railway up`)
 *
 * Requires: `railway` CLI installed and linked.
 * Reversible: yes — Railway supports rollback via dashboard.
 */
export async function deployToRailway(
  projectDir: string,
  config: ActuatorConfig,
): Promise<ActuatorResult> {
  const action = "deploy:railway";
  const target = projectDir;

  const blocked = checkTarget(target, config);
  if (blocked) return fail(action, target, blocked);

  log(action, target, config.dryRun, "railway up");

  if (config.dryRun) {
    return ok(action, target, "DRY RUN: would run `railway up`", {
      reversible: true,
      undoCommand: "Rollback via Railway dashboard",
    });
  }

  const result = await exec(["railway", "up"], projectDir);

  if (result.exitCode !== 0) {
    return fail(action, target, `Exit ${result.exitCode}: ${result.stderr || result.stdout}`);
  }

  return ok(action, target, result.stdout, {
    reversible: true,
    undoCommand: "Rollback via Railway dashboard",
  });
}

/**
 * Deploy to Fly.io (runs `fly deploy`)
 *
 * Requires: `fly` CLI installed and authenticated.
 * Reversible: yes — `fly releases` + `fly deploy --image` to rollback.
 */
export async function deployToFly(
  projectDir: string,
  config: ActuatorConfig,
): Promise<ActuatorResult> {
  const action = "deploy:fly";
  const target = projectDir;

  const blocked = checkTarget(target, config);
  if (blocked) return fail(action, target, blocked);

  log(action, target, config.dryRun, "fly deploy");

  if (config.dryRun) {
    return ok(action, target, "DRY RUN: would run `fly deploy`", {
      reversible: true,
      undoCommand: `cd ${projectDir} && fly releases && fly deploy --image <previous>`,
    });
  }

  const result = await exec(["fly", "deploy"], projectDir);

  if (result.exitCode !== 0) {
    return fail(action, target, `Exit ${result.exitCode}: ${result.stderr || result.stdout}`);
  }

  return ok(action, target, result.stdout, {
    reversible: true,
    undoCommand: `cd ${projectDir} && fly releases`,
  });
}
