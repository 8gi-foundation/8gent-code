#!/usr/bin/env bun
/**
 * Automatic Changelog Generator for 8gent-code
 *
 * Parses git log between tags (or since a given ref/date), groups commits by
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

export interface ChangelogOptions {
  since?: string;
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

function detectBreaking(commit: Commit): boolean {
  return /^[a-z]+(\(.+\))?!:/.test(commit.subject) || commit.body.includes("BREAKING CHANGE");
}

function extractType(subject: string): string {
  const match = subject.match(/^([a-z]+)(\(.+?\))?!?:\s/);
  return match ? match[1] : "other";
}

function formatEntry(commit: Commit): string {
  const clean = commit.subject.replace(/^[a-z]+(\(.+?\))?!?:\s*/, "");
  const prLink = commit.pr ? ` ([#${commit.pr}](${REPO_URL}/pull/${commit.pr}))` : "";
  const hashLink = ` [\`${commit.hash}\`](${REPO_URL}/commit/${commit.hash})`;
  return `- ${clean}${prLink}${hashLink}`;
}

function groupCommits(commits: Commit[]): GroupedChanges {
  const groups: GroupedChanges = { breaking: [], added: [], fixed: [], changed: [], docs: [], removed: [], other: [] };
  for (const commit of commits) {
    if (detectBreaking(commit)) groups.breaking.push(formatEntry(commit));
    const bucket = TYPE_MAP[extractType(commit.subject)] ?? "other";
    groups[bucket].push(formatEntry(commit));
  }
  return groups;
}

function renderMarkdown(groups: GroupedChanges, since: string, until: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const label = until === "HEAD" ? "[Unreleased]" : `[${until.replace(/^v/, "")}]`;
  const lines: string[] = [`## ${label} - ${today}`, "", `_Changes from \`${since}\` to \`${until}\`_`, ""];
  const sections: [keyof GroupedChanges, string][] = [
    ["breaking", "BREAKING CHANGES"], ["added", "Added"], ["fixed", "Fixed"],
    ["changed", "Changed"], ["docs", "Documentation"], ["removed", "Removed"], ["other", "Other"],
  ];
  let any = false;
  for (const [key, heading] of sections) {
    if (groups[key].length > 0) {
      any = true;
      lines.push(`### ${heading}`, "", ...groups[key], "");
    }
  }
  if (!any) lines.push("_No changes in this range._", "");
  return lines.join("\n");
}

export async function generateChangelog(options: ChangelogOptions = {}): Promise<string> {
  const until = options.until ?? "HEAD";
  const since = options.since ?? (await getLatestTag());
  if (!since) throw new Error("No tag found and no `since` option provided.");
  const commits = await getCommits(since, until);
  return renderMarkdown(groupCommits(commits), since, until);
}

async function main() {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i !== -1 && args[i + 1] ? args[i + 1] : undefined;
  };
  try {
    process.stdout.write(await generateChangelog({ since: get("--since") ?? get("--from"), until: get("--until") ?? get("--to") }));
  } catch (err: unknown) {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

if (import.meta.main) main();
