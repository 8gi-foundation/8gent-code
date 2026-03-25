/**
 * Changelog Parser - Parses CHANGELOG.md files in Keep a Changelog format.
 * Extracts versions, dates, and changes grouped by category.
 * Outputs structured JSON.
 *
 * @see https://keepachangelog.com/en/1.1.0/
 */

export interface ChangelogEntry {
  version: string;
  date: string | null;
  yanked: boolean;
  categories: Record<string, string[]>;
}

export interface ParsedChangelog {
  title: string | null;
  description: string | null;
  entries: ChangelogEntry[];
}

const VERSION_RE = /^##\s+\[([^\]]+)\](?:\s+-\s+(\d{4}-\d{2}-\d{2}))?(.*)$/;
const CATEGORY_RE = /^###\s+(.+)$/;

/**
 * Parse a Keep a Changelog formatted string into structured data.
 */
export function parseChangelog(markdown: string): ParsedChangelog {
  const lines = markdown.split("\n");
  let title: string | null = null;
  let descriptionLines: string[] = [];
  let collectingDescription = false;

  const entries: ChangelogEntry[] = [];
  let current: ChangelogEntry | null = null;
  let currentCategory: string | null = null;

  for (const raw of lines) {
    const line = raw.trimEnd();

    // Title (h1)
    if (!title && line.startsWith("# ")) {
      title = line.slice(2).trim();
      collectingDescription = true;
      continue;
    }

    // Version header (h2)
    const versionMatch = line.match(VERSION_RE);
    if (versionMatch) {
      collectingDescription = false;
      const yanked = versionMatch[3]?.toLowerCase().includes("[yanked]") ?? false;
      current = {
        version: versionMatch[1],
        date: versionMatch[2] ?? null,
        yanked,
        categories: {},
      };
      entries.push(current);
      currentCategory = null;
      continue;
    }

    // Category header (h3)
    const categoryMatch = line.match(CATEGORY_RE);
    if (categoryMatch && current) {
      currentCategory = categoryMatch[1].trim();
      if (!current.categories[currentCategory]) {
        current.categories[currentCategory] = [];
      }
      continue;
    }

    // List item under a category
    if (line.match(/^\s*-\s/) && current && currentCategory) {
      current.categories[currentCategory].push(line.replace(/^\s*-\s+/, ""));
      continue;
    }

    // Description lines (between title and first version)
    if (collectingDescription && line !== "---") {
      if (line.trim()) descriptionLines.push(line.trim());
    }
  }

  return {
    title,
    description: descriptionLines.length > 0 ? descriptionLines.join(" ") : null,
    entries,
  };
}

/**
 * Parse a CHANGELOG.md file from disk and return structured JSON.
 */
export async function parseChangelogFile(path: string): Promise<ParsedChangelog> {
  const file = Bun.file(path);
  const text = await file.text();
  return parseChangelog(text);
}
