#!/usr/bin/env bun
/**
 * Automatic Changelog Generator for 8gent-code
 *
 * Reads git log, groups commits by conventional-commit type,
 * and outputs Keep a Changelog formatted entries.
 *
 * Usage:
 *   bun run packages/proactive/changelog-gen.ts --since v1.0.0
 *   bun run packages/proactive/changelog-gen.ts --since 2026-03-01
 *   bun run packages/proactive/changelog-gen.ts              # since last tag
 */

import { $ } from "bun";

// --- Types ---

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

// --- Helpers ---

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

function parseArgs(): { since: string } {
  const args = process.argv.slice(2);
  const sinceIdx = args.indexOf("--since");
  if (sinceIdx !== -1 && args[sinceIdx + 1]) {
    return { since: args[sinceIdx + 1] };
  }
  return { since: "" };
}

async function getLatestTag(): Promise<string> {
  try {
    const result = await $`git describe --tags --abbrev=0 2>/dev/null`.text();
    return result.trim();
  } catch {
    return "";
  }
}

async function getCommits(since: string): Promise<Commit[]> {
  const REC_SEP = "---8GENT_REC---";
  const FLD_SEP = "---8GENT_FLD---";
  const range = since ? `${since}..HEAD` : "HEAD~50..HEAD";
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
  // Strip conventional prefix for readability
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

function renderChangelog(groups: GroupedChanges, since: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];

  lines.push(`## [Unreleased] - ${today}`);
  lines.push("");
  lines.push(`_Changes since \`${since || "last 50 commits"}\`_`);
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

  for (const [key, heading] of sections) {
    if (groups[key].length > 0) {
      lines.push(`### ${heading}`);
      lines.push("");
      for (const entry of groups[key]) {
        lines.push(entry);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

// --- Main ---

async function main() {
  const { since } = parseArgs();
  const resolvedSince = since || (await getLatestTag());

  if (!resolvedSince) {
    console.error("No tag found and no --since provided. Use: --since <tag|date>");
    process.exit(1);
  }

  console.error(`Generating changelog since ${resolvedSince}...`);

  const commits = await getCommits(resolvedSince);
  if (commits.length === 0) {
    console.error("No commits found in range.");
    process.exit(0);
  }

  console.error(`Found ${commits.length} commits.`);

  const groups = groupCommits(commits);
  const output = renderChangelog(groups, resolvedSince);

  console.log(output);
}

main();
