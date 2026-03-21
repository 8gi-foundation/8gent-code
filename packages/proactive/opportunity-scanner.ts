/**
 * 8gent - Opportunity Scanner
 *
 * Scans GitHub for work opportunities: bounties, good-first-issues, help-wanted.
 * Uses GitHub REST API directly — no library deps.
 *
 * Inspired by: CashClaw (autonomous work discovery patterns)
 */

export interface Opportunity {
  id: string;
  source: "github" | "local-backlog";
  title: string;
  description: string;
  url?: string;
  repo?: string;
  labels: string[];
  estimatedEffort: "trivial" | "small" | "medium" | "large";
  matchScore: number; // 0-1
  status: "found" | "evaluated" | "accepted" | "in-progress" | "delivered" | "rejected";
  bountyValue?: string;
  createdAt: string;
}

// Labels that signal this is approachable / has value
const OPPORTUNITY_LABELS = [
  "good first issue",
  "help wanted",
  "bounty",
  "hacktoberfest",
  "easy",
  "beginner",
  "first-timers-only",
  "up-for-grabs",
];

// Labels that signal complexity for effort estimation
const EFFORT_SIGNALS: Record<Opportunity["estimatedEffort"], string[]> = {
  trivial: ["docs", "documentation", "typo", "trivial", "chore"],
  small: ["good first issue", "easy", "beginner", "minor", "small"],
  medium: ["enhancement", "feature", "medium", "help wanted"],
  large: ["epic", "major", "refactor", "architecture", "large"],
};

function estimateEffort(labels: string[]): Opportunity["estimatedEffort"] {
  const labelNames = labels.map((l) => l.toLowerCase());
  for (const effort of ["trivial", "small", "medium", "large"] as const) {
    if (EFFORT_SIGNALS[effort].some((sig) => labelNames.some((l) => l.includes(sig)))) {
      return effort;
    }
  }
  return "medium";
}

function extractBounty(body: string | null): string | undefined {
  if (!body) return undefined;
  // Common bounty patterns: "$50", "500 USD", "0.1 ETH", "Bountysource"
  const match = body.match(/\$[\d,]+|\d+\s?(USD|ETH|USDC|tokens?)/i);
  return match ? match[0] : undefined;
}

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  labels: Array<{ name: string }>;
  created_at: string;
  repository_url: string;
}

/**
 * Scan GitHub repos for open opportunities.
 * @param repos - Array of "owner/repo" strings
 * @param token - Optional GitHub PAT for higher rate limits
 */
export async function scanGitHubIssues(
  repos: string[],
  token?: string
): Promise<Opportunity[]> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "8gent-opportunity-scanner",
  };
  if (token) headers["Authorization"] = `token ${token}`;

  const opportunities: Opportunity[] = [];

  for (const repo of repos) {
    const labelQuery = OPPORTUNITY_LABELS.slice(0, 5)
      .map((l) => encodeURIComponent(l))
      .join(",");

    const url = `https://api.github.com/repos/${repo}/issues?state=open&labels=${labelQuery}&per_page=20`;

    let issues: GitHubIssue[] = [];
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) {
        // 404 = repo not found, 403 = rate limit — skip silently
        continue;
      }
      issues = (await res.json()) as GitHubIssue[];
    } catch {
      // Network failure — skip this repo
      continue;
    }

    for (const issue of issues) {
      const labels = issue.labels.map((l) => l.name);
      const opp: Opportunity = {
        id: `github-${repo.replace("/", "-")}-${issue.number}`,
        source: "github",
        title: issue.title,
        description: (issue.body || "").slice(0, 500),
        url: issue.html_url,
        repo,
        labels,
        estimatedEffort: estimateEffort(labels),
        matchScore: 0, // filled by capability-matcher
        status: "found",
        bountyValue: extractBounty(issue.body),
        createdAt: issue.created_at,
      };
      opportunities.push(opp);
    }
  }

  return opportunities;
}

/**
 * Scan a local project backlog file (simple text/JSON list).
 * Expects JSON array of { title, description, labels? } objects.
 */
export async function scanLocalBacklog(path: string): Promise<Opportunity[]> {
  let raw: string;
  try {
    raw = await Bun.file(path).text();
  } catch {
    return [];
  }

  let items: Array<{ title: string; description?: string; labels?: string[] }>;
  try {
    items = JSON.parse(raw);
  } catch {
    return [];
  }

  return items.map((item, i) => ({
    id: `local-${i}`,
    source: "local-backlog" as const,
    title: item.title,
    description: item.description || "",
    labels: item.labels || [],
    estimatedEffort: estimateEffort(item.labels || []),
    matchScore: 0,
    status: "found" as const,
    createdAt: new Date().toISOString(),
  }));
}
