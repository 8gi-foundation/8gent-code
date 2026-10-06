#!/usr/bin/env bun
/**
 * Build the CHANGELOG.md section for a release from merged PR titles (#3575).
 *
 *   bun scripts/changelog-release.ts --version 0.20.0            print the section
 *   bun scripts/changelog-release.ts --version 0.20.0 --write    also insert it into CHANGELOG.md
 *
 * Options:
 *   --from <rev>   start (exclusive); default: merge-base of --to and the most
 *                  recently created v* tag that is not on --to itself
 *   --to <rev>     end (inclusive); default: HEAD
 *   --date <d>     section date; default: today (UTC, YYYY-MM-DD)
 *   --out <file>   also write the section to this file (release notes body)
 *   --write        insert the section into CHANGELOG.md under [Unreleased]. If
 *                  hand-written notes are still under [Unreleased] (from before
 *                  #3575), it refuses unless told what to do with them:
 *                  --drop-unreleased   discard them (the generated entries cover the same PRs)
 *                  --keep-unreleased   keep them inside the new version, below the generated groups
 *
 * Only the first-parent history of --to is read, so each merged PR is one entry.
 * Logic and tests: scripts/lib/changelog-release.ts.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { GIT_LOG_FORMAT, insertSection, parseGitLog, renderSection } from "./lib/changelog-release";

function git(args: string[]): string {
  const r = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = process.argv[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`--${name} needs a value`);
  return v;
}

function main(): void {
  const version = arg("version")?.replace(/^v/, "");
  if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("usage: changelog-release.ts --version X.Y.Z [--from rev] [--to rev] [--date d] [--out file] [--write]");
  }
  const to = arg("to") ?? "HEAD";
  // The previous release: the most recently created v* tag other than one on --to,
  // by creation date, not version (old v2.x tags predate the 0.x line). Release
  // tags can sit on bump commits that never reached main, so the range starts at
  // the tag's merge-base with --to, not at the tag itself.
  const toCommit = git(["rev-parse", "--verify", `${to}^{commit}`]).trim();
  const own = new Set(git(["tag", "--points-at", toCommit, "--list", "v*"]).split("\n").filter(Boolean));
  const prevTag = git(["tag", "--list", "v*", "--sort=-creatordate"])
    .split("\n")
    .filter((t) => t && !own.has(t))[0];
  const fromArg = arg("from");
  if (!fromArg && !prevTag) throw new Error("no previous v* tag; pass --from");
  const from = fromArg ?? git(["merge-base", `${prevTag}^{commit}`, toCommit]).trim();
  const date = arg("date") ?? new Date().toISOString().slice(0, 10);
  const raw = git(["log", "--first-parent", `--format=${GIT_LOG_FORMAT}`, `${from}..${to}`]);
  const section = renderSection(version, date, parseGitLog(raw));
  process.stdout.write(section);
  const out = arg("out");
  if (out) writeFileSync(out, section);
  if (process.argv.includes("--write")) {
    const keep = process.argv.includes("--keep-unreleased");
    const drop = process.argv.includes("--drop-unreleased");
    if (keep && drop) throw new Error("pass only one of --keep-unreleased / --drop-unreleased");
    const mode = keep ? "keep" : drop ? "drop" : "refuse";
    writeFileSync("CHANGELOG.md", insertSection(readFileSync("CHANGELOG.md", "utf8"), version, section, mode));
    console.error(`CHANGELOG.md: added [${version}] (${from}..${to})`);
  }
}

try {
  main();
} catch (e) {
  console.error(`changelog-release: ${(e as Error).message}`);
  process.exit(1);
}
