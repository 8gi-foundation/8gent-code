/**
 * Changelog generated at release from merged PR titles (#3575).
 *
 * PRs no longer edit CHANGELOG.md. Every PR used to add a line at the same
 * spot, so each merge made the next PR conflict and rerun CI. The release step
 * builds the section instead, from the first-parent history of main since the
 * previous tag: one entry per merged PR, grouped under Keep a Changelog
 * headings by the conventional-commit type of its title.
 *
 * Pure functions only; git and file IO live in scripts/changelog-release.ts.
 */

/** One merged change on main, as the release sees it. */
export interface MergedChange {
  title: string;
  pr: number | null;
}

/** Keep a Changelog headings, in the order the spec lists them. */
export const HEADINGS = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"] as const;
export type Heading = (typeof HEADINGS)[number];

export interface Entry {
  heading: Heading;
  text: string;
  pr: number | null;
  breaking: boolean;
}

/** Field and record separators used in the `git log --format` this module parses. */
export const FS = "\x1f";
export const RS = "\x1e";
export const GIT_LOG_FORMAT = `%s${FS}%b${RS}`;

const MERGE_COMMIT = /^Merge pull request #(\d+) from \S+/;
const TRAILING_PR = /\s*\(#(\d+)\)\s*$/;
const RELEASE_HOUSEKEEPING = /^(chore\(release\)|release[:(]|chore: bump version)/i;

/**
 * Parse `git log --first-parent --format=GIT_LOG_FORMAT` output.
 * Handles both merge styles on main: squash ("title (#N)") and merge commits
 * ("Merge pull request #N from owner/branch" with the PR title as the body).
 * Release housekeeping commits (version bumps, release PRs) are dropped.
 */
export function parseGitLog(raw: string): MergedChange[] {
  const out: MergedChange[] = [];
  for (const record of raw.split(RS)) {
    const trimmed = record.replace(/^\n+/, "");
    if (!trimmed.trim()) continue;
    const [subject = "", body = ""] = trimmed.split(FS);
    let title = subject.trim();
    let pr: number | null = null;
    const merge = MERGE_COMMIT.exec(title);
    if (merge) {
      pr = Number(merge[1]);
      title = body.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? title;
    } else {
      const tail = TRAILING_PR.exec(title);
      if (tail) {
        pr = Number(tail[1]);
        title = title.slice(0, tail.index).trim();
      }
    }
    if (RELEASE_HOUSEKEEPING.test(title)) continue;
    out.push({ title, pr });
  }
  return out;
}

const CONVENTIONAL = /^([a-zA-Z]+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/;

/** Map one PR title to a Keep a Changelog heading and entry text. */
export function classify(change: MergedChange): Entry {
  const m = CONVENTIONAL.exec(change.title);
  if (!m) return { heading: "Changed", text: change.title, pr: change.pr, breaking: false };
  const type = m[1].toLowerCase();
  const scope = (m[2] ?? "").trim();
  const breaking = m[3] === "!";
  const desc = m[4].trim();
  const text = scope ? `${scope}: ${desc}` : desc;
  const scopes = scope.toLowerCase().split(/[,/\s]+/);
  let heading: Heading;
  if (type === "security" || type === "sec" || scopes.includes("security")) heading = "Security";
  else if (type === "feat") heading = "Added";
  else if (type === "fix") heading = "Fixed";
  else if (type === "revert") heading = "Removed";
  else if (type === "deprecate") heading = "Deprecated";
  else heading = "Changed";
  return { heading, text, pr: change.pr, breaking };
}

/** Render one release section. Entries keep their history order (newest first). */
export function renderSection(
  version: string,
  date: string,
  changes: MergedChange[],
  repoUrl = "https://github.com/8gi-foundation/8gent-code",
): string {
  const entries = changes.map(classify);
  const lines = [`## [${version}] - ${date}`];
  if (entries.length === 0) {
    lines.push("", "No merged pull requests since the previous release.");
  }
  for (const heading of HEADINGS) {
    const group = entries.filter((e) => e.heading === heading);
    if (group.length === 0) continue;
    lines.push("", `### ${heading}`);
    for (const e of group) {
      const ref = e.pr === null ? "" : ` ([#${e.pr}](${repoUrl}/pull/${e.pr}))`;
      lines.push(`- ${e.breaking ? "**Breaking:** " : ""}${e.text}${ref}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Insert a rendered section into CHANGELOG.md text, directly under the
 * `## [Unreleased]` heading. Anything already written under Unreleased is
 * part of this release, so it stays below the generated groups inside the new
 * version. Throws if the version already has a section.
 */
export function insertSection(changelog: string, version: string, section: string): string {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`^## \\[${escaped}\\]`, "m").test(changelog)) {
    throw new Error(`CHANGELOG.md already has a section for ${version}`);
  }
  const unreleased = /^## \[Unreleased\][^\n]*\n/m.exec(changelog);
  if (!unreleased) throw new Error("CHANGELOG.md has no ## [Unreleased] heading");
  const at = unreleased.index + unreleased[0].length;
  const rest = changelog.slice(at).replace(/^\n+/, "");
  return `${changelog.slice(0, at)}\n${section}\n${rest}`;
}
