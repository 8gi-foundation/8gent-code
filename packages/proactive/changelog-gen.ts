#!/usr/bin/env bun
/**
 * Automatic Changelog Generator for 8gent-code
 *
 * Reads git log between tags (or since a given ref/date), groups commits by
 * conventional-commit type, and outputs Keep a Changelog formatted entries.
 *
 * Usage:
 *   bun run packages/proactive/changelog-gen.ts --since v1.0.0
 *   bun run packages/proactive/changelog-gen.ts --since 2026-03-01
 *   bun run packages/proactive/changelog-gen.ts               # since last tag
 *   bun run packages/proactive/changelog-gen.ts --from v0.8.0 --to v1.0.0
 *
 * Exported API:
 *   generateChangelog(options?) => Promise<string>
 */

import { $ } from "bun";

// --- Types ---

export interface ChangelogOptions {
  /** Git ref, tag, or ISO date to start from. Defaults to latest tag. */
  since?: string;
  /** Optional upper bound ref/tag. Defaults to HEAD. */
  until?: string;
}

interface Commit {
  hash: string;
  subject: string;
  body: string;
  date: string;
  pr?: number;
}

interface GroupedChanges {
  breaking: string[];
  added: string[];
  fixed: string[];
  changed: string[];
  docs: string[];
  removed: string[];
  other: string[];
}

// --- Constants ---

const REPO_URL = "https://github.com/PodJamz/8gent-code";

const TYPE_MAP: Record<string, keyof GroupedChanges> = {
  feat: "added",
  fix: "fixed",
  refactor: "changed",
  perf: "changed",
  style: "changed",
  docs: "docs",
  test: "other",
  chore: "other",
  ci: "other",
  build: "other",
  revert: "removed",
};

// --- Git helpers ---

async function getLatestTag(): Promise<string> {
  try {
    const result = await $`git describe --tags --abbrev=0 2>/dev/null`.text();
    return result.trim();
  } catch {
    return "";
  }
}

async function getCommits(since: string, until = "HEAD"): Promise<Commit[]> {
  const REC_SEP = "---8GENT_REC---";
  const FLD_SEP = "---8GENT_FLD---";
  const range = `${since}..${until}`;
  const format = `${REC_SEP}%H${FLD_SEP}%s${FLD_SEP}%b${FLD_SEP}%Y-%m-%d`;

  let raw: string;
  try {
    raw = await $`git log ${range} --pretty=format:${format} --no-merges`.text();
  } catch {
    return [];
  }

  if (!raw.trim()) return [];

  return raw
    .split(REC_SEP)
    .filter((r) => r.trim())
    .map((record) => {
      const [hash, subject, body, date] = record.split(FLD_SEP);
      const prMatch = subject?.match(/\(#(\d+)\)/);
      return {
        hash: (hash ?? "").trim().slice(0, 7),
        subject: (subject ?? "").trim(),
        body: (body ?? "").trim(),
        date: (date ?? "").trim(),
        pr: prMatch ? Number(prMatch[1]) : undefined,
      };
    });
}

// --- Parsing / formatting ---

function detectBreaking(commit: Commit): boolean {
  const subjectBang = /^[a-z]+(\(.+\))?!:/.test(commit.subject);
  const bodyFlag = commit.body.includes("BREAKING CHANGE");
  return subjectBang || bodyFlag;
}

function extractType(subject: string): string {
  const match = subject.match(/^([a-z]+)(\(.+?\))?!?:\s/);
  return match ? match[1] : "other";
}

function formatEntry(commit: Commit): string {
  const clean = commit.subject.replace(/^[a-z]+(\(.+?\))?!?:\s*/, "");
  const prLink = commit.pr
    ? ` ([#${commit.pr}](${REPO_URL}/pull/${commit.pr}))`
    : "";
  const hashLink = ` [\`${commit.hash}\`](${REPO_URL}/commit/${commit.hash})`;
  return `- ${clean}${prLink}${hashLink}`;
}

function groupCommits(commits: Commit[]): GroupedChanges {
  const groups: GroupedChanges = {
    breaking: [],
    added: [],
    fixed: [],
    changed: [],
    docs: [],
    removed: [],
    other: [],
  };

  for (const commit of commits) {
    if (detectBreaking(commit)) {
      groups.breaking.push(formatEntry(commit));
    }
    const type = extractType(commit.subject);
    const bucket = TYPE_MAP[type] ?? "other";
    groups[bucket].push(formatEntry(commit));
  }

  return groups;
}

function renderMarkdown(
  groups: GroupedChanges,
  since: string,
  until: string
): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  const label =
    until === "HEAD" ? "[Unreleased]" : `[${until.replace(/^v/, "")}]`;

  lines.push(`## ${label} - ${today}`);
  lines.push("");
  lines.push(`_Changes from \`${since}\` to \`${until}\`_`);
  lines.push("");

  const sections: [keyof GroupedChanges, string][] = [
    ["breaking", "BREAKING CHANGES"],
    ["added", "Added"],
    ["fixed", "Fixed"],
    ["changed", "Changed"],
    ["docs", "Documentation"],
    ["removed", "Removed"],
    ["other", "Other"],
  ];

  let anySection = false;
  for (const [key, heading] of sections) {
    if (groups[key].length > 0) {
      anySection = true;
      lines.push(`### ${heading}`);
      lines.push("");
      for (const entry of groups[key]) {
        lines.push(entry);
      }
      lines.push("");
    }
  }

  if (!anySection) {
    lines.push("_No changes in this range._");
    lines.push("");
  }

  return lines.join("\n");
}

// --- Public API ---

/**
 * Generate a Keep a Changelog formatted string for the given range.
 *
 * @example
 *   const md = await generateChangelog({ since: "v1.0.0" });
 *   await Bun.write("CHANGELOG_FRAGMENT.md", md);
 */
export async function generateChangelog(
  options: ChangelogOptions = {}
): Promise<string> {
  const until = options.until ?? "HEAD";
  const since = options.since ?? (await getLatestTag());

  if (!since) {
    throw new Error(
      "No tag found and no `since` option provided. " +
        "Pass `{ since: 'v0.1.0' }` or create a git tag first."
    );
  }

  const commits = await getCommits(since, until);
  const groups = groupCommits(commits);
  return renderMarkdown(groups, since, until);
}

// --- CLI entrypoint ---

async function main() {
  const args = process.argv.slice(2);

  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i !== -1 && args[i + 1] ? args[i + 1] : undefined;
  };

  const since = get("--since") ?? get("--from");
  const until = get("--until") ?? get("--to");

  let output: string;
  try {
    output = await generateChangelog({ since, until });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${msg}\n`);
    process.exit(1);
  }

  process.stdout.write(output);
}

if (import.meta.main) {
  main();
}
