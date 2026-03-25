/**
 * changelog-parser.ts
 * Parses Keep a Changelog (https://keepachangelog.com/) markdown format
 * into structured version entries. Supports querying by version range
 * and generating new changelog entries.
 */

export type ChangeCategory =
  | "Added"
  | "Changed"
  | "Deprecated"
  | "Removed"
  | "Fixed"
  | "Security";

export interface ChangeEntry {
  category: ChangeCategory;
  description: string;
}

export interface VersionEntry {
  version: string;
  date: string | null;
  yanked: boolean;
  entries: ChangeEntry[];
}

export interface Changelog {
  header: string;
  versions: VersionEntry[];
}

const VERSION_HEADING = /^##\s+\[(.+?)\](?:\s*-\s*(\d{4}-\d{2}-\d{2}))?(\s+\[YANKED\])?/i;
const CATEGORY_HEADING = /^###\s+(Added|Changed|Deprecated|Removed|Fixed|Security)/i;
const LIST_ITEM = /^[-*]\s+(.+)/;

/**
 * Parse a Keep a Changelog markdown string into a structured Changelog object.
 */
export function parseChangelog(md: string): Changelog {
  const lines = md.split("\n");
  const versions: VersionEntry[] = [];
  let header = "";
  let currentVersion: VersionEntry | null = null;
  let currentCategory: ChangeCategory | null = null;
  let inHeader = true;

  for (const line of lines) {
    const versionMatch = VERSION_HEADING.exec(line);
    if (versionMatch) {
      inHeader = false;
      if (currentVersion) versions.push(currentVersion);
      currentVersion = {
        version: versionMatch[1],
        date: versionMatch[2] ?? null,
        yanked: !!versionMatch[3],
        entries: [],
      };
      currentCategory = null;
      continue;
    }

    const categoryMatch = CATEGORY_HEADING.exec(line);
    if (categoryMatch && currentVersion) {
      currentCategory = categoryMatch[1] as ChangeCategory;
      continue;
    }

    const itemMatch = LIST_ITEM.exec(line);
    if (itemMatch && currentVersion && currentCategory) {
      currentVersion.entries.push({
        category: currentCategory,
        description: itemMatch[1].trim(),
      });
      continue;
    }

    if (inHeader) {
      header += line + "\n";
    }
  }

  if (currentVersion) versions.push(currentVersion);

  return { header: header.trim(), versions };
}

/**
 * Query versions in a semver range (inclusive both ends).
 * Pass null for either bound to leave it open.
 */
export function queryVersionRange(
  changelog: Changelog,
  from: string | null,
  to: string | null
): VersionEntry[] {
  const cmp = (a: string, b: string): number => {
    const pa = a.replace(/[^\d.]/g, "").split(".").map(Number);
    const pb = b.replace(/[^\d.]/g, "").split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  };

  return changelog.versions.filter((v) => {
    if (v.version.toLowerCase() === "unreleased") return false;
    if (from && cmp(v.version, from) < 0) return false;
    if (to && cmp(v.version, to) > 0) return false;
    return true;
  });
}

/**
 * Add a new entry to the Unreleased section (creates it if absent).
 * Returns a new Changelog with the entry added.
 */
export function addEntry(
  changelog: Changelog,
  entry: ChangeEntry
): Changelog {
  const versions = [...changelog.versions];
  const unreleasedIdx = versions.findIndex(
    (v) => v.version.toLowerCase() === "unreleased"
  );

  if (unreleasedIdx >= 0) {
    const unreleased = versions[unreleasedIdx];
    versions[unreleasedIdx] = {
      ...unreleased,
      entries: [...unreleased.entries, entry],
    };
  } else {
    versions.unshift({
      version: "Unreleased",
      date: null,
      yanked: false,
      entries: [entry],
    });
  }

  return { ...changelog, versions };
}

/**
 * Serialize a Changelog back to Keep a Changelog markdown format.
 */
export function serializeChangelog(changelog: Changelog): string {
  const lines: string[] = [];

  if (changelog.header) {
    lines.push(changelog.header, "");
  }

  for (const v of changelog.versions) {
    const dateStr = v.date ? ` - ${v.date}` : "";
    const yankedStr = v.yanked ? " [YANKED]" : "";
    lines.push(`## [${v.version}]${dateStr}${yankedStr}`);

    const byCategory = new Map<ChangeCategory, string[]>();
    for (const entry of v.entries) {
      if (!byCategory.has(entry.category)) byCategory.set(entry.category, []);
      byCategory.get(entry.category)!.push(entry.description);
    }

    for (const [cat, descs] of byCategory) {
      lines.push("", `### ${cat}`);
      for (const d of descs) lines.push(`- ${d}`);
    }

    lines.push("");
  }

  return lines.join("\n");
}
