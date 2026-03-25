#!/usr/bin/env bun
/**
 * User-Friendly Release Notes Generator
 *
 * Generates polished, emoji-prefixed release notes from git log and PR titles.
 * Groups changes by feature/fix/docs, includes contributor mentions.
 *
 * Usage:
 *   bun run packages/proactive/release-notes.ts --since v1.0.0
 *   bun run packages/proactive/release-notes.ts --since 2026-03-01
 *   bun run packages/proactive/release-notes.ts              # since last tag
 */

import { $ } from "bun";

// --- Types ---

interface Commit {
  hash: string;
  subject: string;
  author: string;
  date: string;
  pr?: number;
}

interface ReleaseGroup {
  features: string[];
  fixes: string[];
  docs: string[];
  improvements: string[];
  other: string[];
}

// --- Constants ---

const REPO_URL = "https://github.com/PodJamz/8gent-code";

const EMOJI_MAP: Record<keyof ReleaseGroup, string> = {
  features: "rocket",
  fixes: "bug",
  docs: "book",
  improvements: "sparkles",
  other: "wrench",
};

const HEADING_MAP: Record<keyof ReleaseGroup, string> = {
  features: "New Features",
  fixes: "Bug Fixes",
  docs: "Documentation",
  improvements: "Improvements",
  other: "Other Changes",
};

const TYPE_TO_GROUP: Record<string, keyof ReleaseGroup> = {
  feat: "features",
  fix: "fixes",
  docs: "docs",
  refactor: "improvements",
  perf: "improvements",
  style: "improvements",
  chore: "other",
  ci: "other",
  build: "other",
  test: "other",
  revert: "other",
};

// --- Helpers ---

function parseArgs(): { since: string } {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--since");
  if (idx !== -1 && args[idx + 1]) return { since: args[idx + 1] };
  return { since: "" };
}

async function getLatestTag(): Promise<string> {
  try {
    return (await $`git describe --tags --abbrev=0 2>/dev/null`.text()).trim();
  } catch {
    return "";
  }
}

async function getCommits(since: string): Promise<Commit[]> {
  const SEP = "<<8GENT>>";
  const REC = "<<REC>>";
  const range = since ? `${since}..HEAD` : "HEAD~50..HEAD";
  const fmt = `${REC}%H${SEP}%s${SEP}%aN${SEP}%Y-%m-%d`;

  let raw: string;
  try {
    raw = await $`git log ${range} --pretty=format:${fmt} --no-merges`.text();
  } catch {
    return [];
  }

  if (!raw.trim()) return [];

  return raw
    .split(REC)
    .filter((r) => r.trim())
    .map((record) => {
      const [hash, subject, author, date] = record.split(SEP);
      const prMatch = subject?.match(/\(#(\d+)\)/);
      return {
        hash: (hash ?? "").trim().slice(0, 7),
        subject: (subject ?? "").trim(),
        author: (author ?? "").trim(),
        date: (date ?? "").trim(),
        pr: prMatch ? Number(prMatch[1]) : undefined,
      };
    });
}

function classifyCommit(subject: string): keyof ReleaseGroup {
  const match = subject.match(/^([a-z]+)(\(.+?\))?!?:\s/);
  if (!match) return "other";
  return TYPE_TO_GROUP[match[1]] ?? "other";
}

function cleanSubject(subject: string): string {
  return subject.replace(/^[a-z]+(\(.+?\))?!?:\s*/, "");
}

function formatEntry(commit: Commit): string {
  const desc = cleanSubject(commit.subject);
  const prLink = commit.pr ? ` ([#${commit.pr}](${REPO_URL}/pull/${commit.pr}))` : "";
  const hashLink = ` [\`${commit.hash}\`](${REPO_URL}/commit/${commit.hash})`;
  const mention = commit.author ? ` - @${commit.author}` : "";
  return `- ${desc}${prLink}${hashLink}${mention}`;
}

function groupCommits(commits: Commit[]): ReleaseGroup {
  const groups: ReleaseGroup = {
    features: [],
    fixes: [],
    docs: [],
    improvements: [],
    other: [],
  };

  for (const commit of commits) {
    const bucket = classifyCommit(commit.subject);
    groups[bucket].push(formatEntry(commit));
  }

  return groups;
}

function collectContributors(commits: Commit[]): string[] {
  const seen = new Set<string>();
  for (const c of commits) {
    if (c.author) seen.add(c.author);
  }
  return [...seen].sort();
}

function render(groups: ReleaseGroup, since: string, contributors: string[]): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];

  lines.push(`# Release Notes - ${today}`);
  lines.push("");
  lines.push(`Changes since \`${since || "last 50 commits"}\`.`);
  lines.push("");

  const sections: (keyof ReleaseGroup)[] = [
    "features",
    "fixes",
    "docs",
    "improvements",
    "other",
  ];

  for (const key of sections) {
    if (groups[key].length === 0) continue;
    const emoji = EMOJI_MAP[key];
    const heading = HEADING_MAP[key];
    lines.push(`## :${emoji}: ${heading}`);
    lines.push("");
    for (const entry of groups[key]) {
      lines.push(entry);
    }
    lines.push("");
  }

  if (contributors.length > 0) {
    lines.push("## :heart: Contributors");
    lines.push("");
    lines.push(contributors.map((c) => `- @${c}`).join("\n"));
    lines.push("");
  }

  return lines.join("\n");
}

// --- Main ---

async function main() {
  const { since } = parseArgs();
  const resolved = since || (await getLatestTag());

  if (!resolved) {
    console.error("No tag found and no --since provided. Use: --since <tag|date>");
    process.exit(1);
  }

  console.error(`Generating release notes since ${resolved}...`);

  const commits = await getCommits(resolved);
  if (commits.length === 0) {
    console.error("No commits found in range.");
    process.exit(0);
  }

  console.error(`Found ${commits.length} commits.`);

  const groups = groupCommits(commits);
  const contributors = collectContributors(commits);
  const output = render(groups, resolved, contributors);

  console.log(output);
}

export { getCommits, groupCommits, collectContributors, render };
export type { Commit, ReleaseGroup };

main();
