/**
 * blame-analyzer.ts - Git blame codebase ownership report
 *
 * Analyzes git blame across tracked files to produce:
 * 1. Most-edited files (by unique commit count)
 * 2. Code ownership distribution (lines per author)
 * 3. Code age distribution (lines by age bucket)
 */

import { $ } from "bun";

interface FileEditInfo {
  path: string;
  commitCount: number;
}

interface OwnershipEntry {
  author: string;
  lines: number;
  percentage: number;
}

interface AgeBucket {
  label: string;
  lines: number;
  percentage: number;
}

export interface BlameReport {
  totalFiles: number;
  totalLines: number;
  mostEdited: FileEditInfo[];
  ownership: OwnershipEntry[];
  age: AgeBucket[];
  generatedAt: string;
}

function ageBucket(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const days = (now - then) / (1000 * 60 * 60 * 24);
  if (days < 7) return "< 1 week";
  if (days < 30) return "1-4 weeks";
  if (days < 90) return "1-3 months";
  if (days < 180) return "3-6 months";
  if (days < 365) return "6-12 months";
  return "> 1 year";
}

export async function analyzeBlame(
  repoPath: string,
  topN = 15,
): Promise<BlameReport> {
  const files =
    (await $`git -C ${repoPath} ls-files -- '*.ts' '*.tsx' '*.js' '*.jsx'`.text())
      .trim()
      .split("\n")
      .filter(Boolean);

  const authorLines: Record<string, number> = {};
  const ageBuckets: Record<string, number> = {};
  const fileCommits: FileEditInfo[] = [];
  let totalLines = 0;

  for (const file of files) {
    try {
      const raw =
        await $`git -C ${repoPath} blame --line-porcelain -- ${file}`.text();
      const lines = raw.split("\n");
      const commits = new Set<string>();
      let currentAuthor = "";
      let currentDate = "";

      for (const line of lines) {
        if (/^[0-9a-f]{40} /.test(line)) {
          commits.add(line.slice(0, 40));
        } else if (line.startsWith("author ")) {
          currentAuthor = line.slice(7);
        } else if (line.startsWith("author-time ")) {
          currentDate = new Date(parseInt(line.slice(12)) * 1000).toISOString();
        } else if (line.startsWith("\t")) {
          // content line - tally the previous author/date
          totalLines++;
          authorLines[currentAuthor] = (authorLines[currentAuthor] || 0) + 1;
          const bucket = ageBucket(currentDate);
          ageBuckets[bucket] = (ageBuckets[bucket] || 0) + 1;
        }
      }

      fileCommits.push({ path: file, commitCount: commits.size });
    } catch {
      // skip files that fail blame (binary, submodule, etc.)
    }
  }

  const mostEdited = fileCommits
    .sort((a, b) => b.commitCount - a.commitCount)
    .slice(0, topN);

  const ownership = Object.entries(authorLines)
    .sort((a, b) => b[1] - a[1])
    .map(([author, lines]) => ({
      author,
      lines,
      percentage: Math.round((lines / totalLines) * 1000) / 10,
    }));

  const bucketOrder = [
    "< 1 week", "1-4 weeks", "1-3 months",
    "3-6 months", "6-12 months", "> 1 year",
  ];
  const age = bucketOrder
    .filter((b) => ageBuckets[b])
    .map((label) => ({
      label,
      lines: ageBuckets[label],
      percentage: Math.round((ageBuckets[label] / totalLines) * 1000) / 10,
    }));

  return {
    totalFiles: files.length,
    totalLines,
    mostEdited,
    ownership,
    age,
    generatedAt: new Date().toISOString(),
  };
}

// CLI entry point
if (import.meta.main) {
  const repo = process.argv[2] || ".";
  const report = await analyzeBlame(repo);
  console.log(JSON.stringify(report, null, 2));
}
