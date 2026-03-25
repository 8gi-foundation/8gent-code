/**
 * PR Auto-Labeler for 8gent
 *
 * Reads a PR diff via GitHub API and applies labels based on:
 * - File paths touched (app, package, benchmark, docs, quarantine)
 * - Change size (small <100, medium 100-500, large 500+)
 *
 * Usage:
 *   CLI:    GITHUB_TOKEN=xxx bun run packages/proactive/pr-labeler.ts owner/repo 42
 *   Action: see .github/workflows/pr-labeler.yml
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PRFile {
  filename: string;
  additions: number;
  deletions: number;
  changes: number;
}

interface LabelResult {
  path_labels: string[];
  size_label: string;
  total_changes: number;
  all_labels: string[];
}

// ---------------------------------------------------------------------------
// Path rules - order does not matter; a PR can earn multiple labels
// ---------------------------------------------------------------------------

const PATH_RULES: Array<{ prefix: string; label: string }> = [
  { prefix: "apps/", label: "app" },
  { prefix: "packages/", label: "package" },
  { prefix: "benchmarks/", label: "benchmark" },
  { prefix: "docs/", label: "docs" },
  { prefix: "quarantine/", label: "quarantine" },
];

// ---------------------------------------------------------------------------
// Size thresholds
// ---------------------------------------------------------------------------

function sizeLabel(totalChanges: number): string {
  if (totalChanges < 100) return "size/small";
  if (totalChanges <= 500) return "size/medium";
  return "size/large";
}

// ---------------------------------------------------------------------------
// Core logic - pure function, no side effects
// ---------------------------------------------------------------------------

export function deriveLabels(files: PRFile[]): LabelResult {
  const pathLabels = new Set<string>();

  let totalChanges = 0;
  for (const file of files) {
    totalChanges += file.changes;
    for (const rule of PATH_RULES) {
      if (file.filename.startsWith(rule.prefix)) {
        pathLabels.add(rule.label);
      }
    }
  }

  const size = sizeLabel(totalChanges);
  const pathArr = Array.from(pathLabels).sort();

  return {
    path_labels: pathArr,
    size_label: size,
    total_changes: totalChanges,
    all_labels: [...pathArr, size],
  };
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

async function fetchPRFiles(
  repo: string,
  pr: number,
  token: string,
): Promise<PRFile[]> {
  const url = `https://api.github.com/repos/${repo}/pulls/${pr}/files`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as PRFile[];
}

async function applyLabels(
  repo: string,
  pr: number,
  labels: string[],
  token: string,
): Promise<void> {
  const url = `https://api.github.com/repos/${repo}/issues/${pr}/labels`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ labels }),
  });
  if (!res.ok) {
    throw new Error(`GitHub label API ${res.status}: ${await res.text()}`);
  }
}

// ---------------------------------------------------------------------------
// Public entry point - fetch, derive, apply
// ---------------------------------------------------------------------------

export async function labelPR(
  repo: string,
  pr: number,
  token: string,
  dryRun = false,
): Promise<LabelResult> {
  const files = await fetchPRFiles(repo, pr, token);
  const result = deriveLabels(files);

  if (!dryRun) {
    await applyLabels(repo, pr, result.all_labels, token);
  }

  return result;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const repo = process.argv[2] ?? process.env.GITHUB_REPOSITORY;
  const pr = Number(process.argv[3] ?? process.env.PR_NUMBER);
  const token = process.env.GITHUB_TOKEN ?? "";
  const dryRun = process.argv.includes("--dry-run");

  if (!repo || !pr || !token) {
    console.error("Usage: GITHUB_TOKEN=xxx bun run pr-labeler.ts owner/repo 42 [--dry-run]");
    process.exit(1);
  }

  const result = await labelPR(repo, pr, token, dryRun);
  console.log(JSON.stringify(result, null, 2));
  if (dryRun) {
    console.log("(dry run - no labels applied)");
  }
}
