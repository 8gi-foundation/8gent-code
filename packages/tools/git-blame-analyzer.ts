import { execSync } from "child_process";

export interface BlameEntry {
  hash: string;
  author: string;
  email: string;
  date: string;
  line: number;
  content: string;
}

export interface AuthorStats {
  author: string;
  email: string;
  lines: number;
  percentage: number;
  files: Set<string>;
}

export interface BlameReport {
  filePath: string;
  totalLines: number;
  authors: AuthorStats[];
  hotspot: AuthorStats | null;
  lastModified: string;
}

export interface RepoOwnershipReport {
  files: BlameReport[];
  topContributors: { author: string; totalLines: number; percentage: number }[];
}

function parseBlameOutput(raw: string): BlameEntry[] {
  const entries: BlameEntry[] = [];
  const lines = raw.split("\n");
  let current: Partial<BlameEntry> = {};

  for (const line of lines) {
    const hashMatch = line.match(/^([0-9a-f]{40})\s+\S+\s+(\d+)\)/);
    if (hashMatch) {
      current.hash = hashMatch[1];
      current.line = parseInt(hashMatch[2]);
      current.content = line.slice(line.indexOf(")") + 2);
      if (current.hash && current.author && current.email && current.date) {
        entries.push(current as BlameEntry);
      }
      current = {};
      continue;
    }
    if (line.startsWith("author ") && !line.startsWith("author-")) {
      current.author = line.slice(7).trim();
    } else if (line.startsWith("author-mail ")) {
      current.email = line.slice(12).replace(/[<>]/g, "").trim();
    } else if (line.startsWith("author-time ")) {
      const ts = parseInt(line.slice(12).trim());
      current.date = new Date(ts * 1000).toISOString().split("T")[0];
    }
  }

  return entries;
}

function aggregateByAuthor(entries: BlameEntry[], filePath: string): AuthorStats[] {
  const map = new Map<string, AuthorStats>();

  for (const entry of entries) {
    const key = entry.email;
    if (!map.has(key)) {
      map.set(key, { author: entry.author, email: entry.email, lines: 0, percentage: 0, files: new Set() });
    }
    const stats = map.get(key)!;
    stats.lines += 1;
    stats.files.add(filePath);
  }

  const total = entries.length;
  for (const stats of map.values()) {
    stats.percentage = total > 0 ? Math.round((stats.lines / total) * 1000) / 10 : 0;
  }

  return Array.from(map.values()).sort((a, b) => b.lines - a.lines);
}

export function analyzeBlame(filePath: string): BlameReport {
  let raw: string;
  try {
    raw = execSync(`git blame --porcelain "${filePath}"`, { encoding: "utf8", cwd: process.cwd() });
  } catch (err) {
    throw new Error(`git blame failed for ${filePath}: ${err}`);
  }

  const entries = parseBlameOutput(raw);
  const authors = aggregateByAuthor(entries, filePath);
  const lastModified =
    entries.length > 0
      ? entries.reduce((latest, e) => (e.date > latest ? e.date : latest), "")
      : "unknown";

  return { filePath, totalLines: entries.length, authors, hotspot: authors[0] ?? null, lastModified };
}

export function analyzeRepoOwnership(files: string[]): RepoOwnershipReport {
  const reports = files.map((f) => analyzeBlame(f));
  const authorTotals = new Map<string, { author: string; totalLines: number }>();
  let grandTotal = 0;

  for (const report of reports) {
    grandTotal += report.totalLines;
    for (const a of report.authors) {
      if (!authorTotals.has(a.email)) {
        authorTotals.set(a.email, { author: a.author, totalLines: 0 });
      }
      authorTotals.get(a.email)!.totalLines += a.lines;
    }
  }

  const topContributors = Array.from(authorTotals.values())
    .sort((a, b) => b.totalLines - a.totalLines)
    .map((c) => ({
      author: c.author,
      totalLines: c.totalLines,
      percentage: grandTotal > 0 ? Math.round((c.totalLines / grandTotal) * 1000) / 10 : 0,
    }));

  return { files: reports, topContributors };
}
