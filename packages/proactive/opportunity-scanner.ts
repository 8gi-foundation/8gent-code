/**
 * 8gent - Opportunity Scanner
 *
 * Scans GitHub for work opportunities: bounties, good-first-issues, help-wanted.
 * Also scans Discussions, Contributing sections, and TODO/FIXME markers in code.
 * Uses GitHub REST API directly - no library deps.
 *
 * Inspired by: CashClaw (autonomous work discovery patterns)
 * Reference: Paperclip - autonomous agent work platform (goal-aligned task discovery)
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
        // 404 = repo not found, 403 = rate limit - skip silently
        continue;
      }
      issues = (await res.json()) as GitHubIssue[];
    } catch {
      // Network failure - skip this repo
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

// -- GitHub Discussions -------------------------------------------------

interface GitHubDiscussion {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  category: { name: string };
  created_at: string;
}

/**
 * Scan GitHub Discussions for help-seeking threads.
 * Looks for "Q&A" and "Help" category discussions as collaboration opportunities.
 */
export async function scanGitHubDiscussions(
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
    const [owner, repoName] = repo.split("/");
    const query = `
      query {
        repository(owner: "${owner}", name: "${repoName}") {
          discussions(first: 10, orderBy: {field: UPDATED_AT, direction: DESC}) {
            nodes {
              number title body url
              category { name }
              createdAt
            }
          }
        }
      }`;

    let discussions: GitHubDiscussion[] = [];
    try {
      const res = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      if (!res.ok) continue;
      const data = await res.json() as {
        data?: { repository?: { discussions?: { nodes?: GitHubDiscussion[] } } };
      };
      discussions = data?.data?.repository?.discussions?.nodes ?? [];
    } catch {
      continue;
    }

    for (const disc of discussions) {
      const categoryName = disc.category?.name?.toLowerCase() ?? "";
      if (!categoryName.match(/help|q&a|question|support/)) continue;

      opportunities.push({
        id: `github-discussion-${repo.replace("/", "-")}-${disc.number}`,
        source: "github",
        title: disc.title,
        description: (disc.body || "").slice(0, 500),
        url: disc.html_url,
        repo,
        labels: ["discussion", categoryName],
        estimatedEffort: "small",
        matchScore: 0,
        status: "found",
        createdAt: disc.created_at,
      });
    }
  }

  return opportunities;
}

// -- Contributing section scanner ---------------------------------------

/**
 * Scan a repo's CONTRIBUTING.md for maintainer needs.
 * Surfaces "help wanted" signals from the contributing guide.
 */
export async function scanContributingSection(
  repos: string[],
  token?: string
): Promise<Opportunity[]> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "8gent-opportunity-scanner",
  };
  if (token) headers["Authorization"] = `token ${token}`;

  const opportunities: Opportunity[] = [];
  const NEED_PATTERNS = [
    /help\s+wanted/i, /looking\s+for\s+(contributor|help)/i,
    /we\s+need/i, /seeking\s+(help|contributor)/i,
    /good\s+first\s+(issue|contribution)/i,
  ];

  for (const repo of repos) {
    for (const filename of ["CONTRIBUTING.md", "CONTRIBUTING", "contributing.md"]) {
      const url = `https://api.github.com/repos/${repo}/contents/${filename}`;
      try {
        const res = await fetch(url, { headers });
        if (!res.ok) continue;
        const meta = await res.json() as { content?: string };
        const raw = meta.content ? Buffer.from(meta.content, "base64").toString() : "";
        if (!raw) continue;

        const matchedPatterns = NEED_PATTERNS.filter((p) => p.test(raw));
        if (matchedPatterns.length === 0) continue;

        opportunities.push({
          id: `github-contributing-${repo.replace("/", "-")}`,
          source: "github",
          title: `Maintainer needs contributors - ${repo}`,
          description: raw.slice(0, 500),
          url: `https://github.com/${repo}/blob/main/${filename}`,
          repo,
          labels: ["contributing", "help-wanted"],
          estimatedEffort: "small",
          matchScore: 0,
          status: "found",
          createdAt: new Date().toISOString(),
        });
        break;
      } catch {
        continue;
      }
    }
  }

  return opportunities;
}

// -- TODO/FIXME code scanner -------------------------------------------

interface GitHubSearchResult {
  total_count: number;
  items: Array<{
    name: string;
    path: string;
    html_url: string;
    repository: { full_name: string };
  }>;
}

/**
 * Search for repos with TODO/FIXME markers via GitHub code search.
 * Surfaces potential contribution opportunities in active projects.
 */
export async function scanCodeTodos(
  query: string,
  token?: string,
  maxResults = 10
): Promise<Opportunity[]> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "8gent-opportunity-scanner",
  };
  if (token) headers["Authorization"] = `token ${token}`;

  const searchUrl = `https://api.github.com/search/code?q=${encodeURIComponent(query + " TODO OR FIXME")}&per_page=${maxResults}`;

  try {
    const res = await fetch(searchUrl, { headers });
    if (!res.ok) return [];
    const data = await res.json() as GitHubSearchResult;

    return data.items.map((item) => ({
      id: `github-todo-${item.repository.full_name.replace("/", "-")}-${item.path.replace(/\//g, "-")}`,
      source: "github" as const,
      title: `TODO/FIXME in ${item.path} (${item.repository.full_name})`,
      description: `Potential improvement opportunity in ${item.path}`,
      url: item.html_url,
      repo: item.repository.full_name,
      labels: ["todo", "code-quality"],
      estimatedEffort: "small" as const,
      matchScore: 0,
      status: "found" as const,
      createdAt: new Date().toISOString(),
    }));
  } catch {
    return [];
  }
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
