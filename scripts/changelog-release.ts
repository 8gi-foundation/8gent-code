#!/usr/bin/env bun
/**
 * Build the CHANGELOG.md section for a release from merged PR titles (#3575).
 *
 *   bun scripts/changelog-release.ts --version 0.20.0            print the section
 *   bun scripts/changelog-release.ts --version 0.20.0 --write    also insert it into CHANGELOG.md
 *
 * Options:
 *   --from <rev>   start (exclusive); default: newest v* tag reachable from --to,
 *                  not counting a tag on --to itself
 *   --to <rev>     end (inclusive); default: HEAD
 *   --date <d>     section date; default: today (UTC, YYYY-MM-DD)
 *   --out <file>   also write the section to this file (release notes body)
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
  // The previous release: newest v* tag reachable from --to, other than a tag on --to itself.
  const own = git(["tag", "--points-at", to, "--list", "v*"]).split("\n").filter(Boolean);
  const from =
    arg("from") ??
    git(["describe", "--tags", "--abbrev=0", "--match", "v*", ...own.flatMap((t) => ["--exclude", t]), to]).trim();
  const date = arg("date") ?? new Date().toISOString().slice(0, 10);
  const raw = git(["log", "--first-parent", `--format=${GIT_LOG_FORMAT}`, `${from}..${to}`]);
  const section = renderSection(version, date, parseGitLog(raw));
  process.stdout.write(section);
  const out = arg("out");
  if (out) writeFileSync(out, section);
  if (process.argv.includes("--write")) {
    writeFileSync("CHANGELOG.md", insertSection(readFileSync("CHANGELOG.md", "utf8"), version, section));
    console.error(`CHANGELOG.md: added [${version}] (${from}..${to})`);
  }
}

try {
  main();
} catch (e) {
  console.error(`changelog-release: ${(e as Error).message}`);
  process.exit(1);
}
