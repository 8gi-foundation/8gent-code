/**
 * 8gent - GitHub Issue Scanner
 *
 * Fetches "good first issue" and "help wanted" issues from popular repos
 * via GitHub Search API. Filters for TypeScript/Bun/React/CLI relevance,
 * scores by bounty value + complexity + skill match, and outputs a daily
 * digest of top 5 opportunities.
 *
 * Designed to run as a cron job via the daemon (daily cadence).
 * No external deps - uses fetch + existing proactive types.
 */

import type { Opportunity } from "./opportunity-scanner.ts";
import { evaluateOpportunity, DEFAULT_CAPABILITIES } from "./capability-matcher.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface IssueScannerConfig {
  /** GitHub PAT for higher rate limits. Optional but recommended. */
  token?: string;
  /** Max results per search query. Default: 30 */
  perPage?: number;
  /** How many top opportunities to include in the digest. Default: 5 */
  digestSize?: number;
  /** Extra capability keys beyond defaults. */
  extraCapabilities?: string[];
  /** Custom repos to always scan (in addition to search results). */
  pinnedRepos?: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Search queries targeting Eight's sweet spot. */
const SEARCH_QUERIES = [
  'label:"good first issue" language:TypeScript state:open',
  'label:"help wanted" language:TypeScript state:open',
  'label:"good first issue" language:TypeScript "bun" state:open',
  'label:"help wanted" "react" "cli" language:TypeScript state:open',
  'label:"bounty" language:TypeScript state:open',
] as const;

/** Keywords that signal a TypeScript/Bun/React/CLI issue we can handle. */
const SKILL_KEYWORDS = [
  "typescript", "bun", "react", "ink", "cli", "tui", "terminal",
  "node", "next.js", "nextjs", "api", "rest", "graphql", "test",
  "vitest", "jest", "eslint", "prettier", "sqlite", "ollama",
];

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

interface GitHubSearchResponse {
  total_count: number;
  incomplete_results: boolean;
  items: GitHubSearchIssue[];
}

interface GitHubSearchIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  labels: Array<{ name: string }>;
  created_at: string;
  repository_url: string; // https://api.github.com/repos/owner/name
  reactions?: { total_count?: number };
}

function repoFromUrl(apiUrl: string): string {
  // "https://api.github.com/repos/vercel/next.js" -> "vercel/next.js"
  return apiUrl.replace("https://api.github.com/repos/", "");
}

function headers(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "8gent-issue-scanner",
  };
  if (token) h["Authorization"] = `token ${token}`;
  return h;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function extractBountyValue(body: string | null): number {
  if (!body) return 0;
  const match = body.match(/\$\s?([\d,]+)/);
  if (!match) return 0;
  return parseInt(match[1].replace(/,/g, ""), 10) || 0;
}

function skillRelevance(title: string, body: string | null): number {
  const text = `${title} ${body ?? ""}`.toLowerCase();
  let hits = 0;
  for (const kw of SKILL_KEYWORDS) {
    if (text.includes(kw)) hits++;
  }
  // Normalize: 3+ keyword hits = max relevance
  return Math.min(1, hits / 3);
}

function complexityEstimate(labels: string[]): number {
  const names = labels.map((l) => l.toLowerCase());
  if (names.some((l) => l.includes("trivial") || l.includes("docs") || l.includes("typo"))) return 1.0;
  if (names.some((l) => l.includes("good first issue") || l.includes("easy") || l.includes("beginner"))) return 0.85;
  if (names.some((l) => l.includes("help wanted") || l.includes("enhancement"))) return 0.6;
  if (names.some((l) => l.includes("epic") || l.includes("major"))) return 0.2;
  return 0.5;
}

/**
 * Combined score: 40% skill relevance, 30% complexity (simpler = higher),
 * 20% capability matcher, 10% bounty bonus.
 */
function scoreIssue(issue: GitHubSearchIssue, capScore: number): number {
  const labels = issue.labels.map((l) => l.name);
  const skill = skillRelevance(issue.title, issue.body);
  const complexity = complexityEstimate(labels);
  const bounty = Math.min(1, extractBountyValue(issue.body) / 500); // $500+ = max

  return skill * 0.4 + complexity * 0.3 + capScore * 0.2 + bounty * 0.1;
}

// ---------------------------------------------------------------------------
// Core scanner
// ---------------------------------------------------------------------------

/**
 * Scan GitHub for issues matching Eight's capabilities.
 * Deduplicates across queries, scores, and returns sorted results.
 */
export async function scanIssues(
  config: IssueScannerConfig = {}
): Promise<Opportunity[]> {
  const { token, perPage = 30 } = config;
  const seen = new Set<string>();
  const raw: GitHubSearchIssue[] = [];

  for (const q of SEARCH_QUERIES) {
    const url = `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=${perPage}&sort=created&order=desc`;
    try {
      const res = await fetch(url, { headers: headers(token) });
      if (!res.ok) continue;
      const data = (await res.json()) as GitHubSearchResponse;
      for (const item of data.items) {
        const key = item.html_url;
        if (seen.has(key)) continue;
        seen.add(key);
        raw.push(item);
      }
    } catch {
      continue;
    }
  }

  // Convert to Opportunity and score
  const capabilities = [
    ...DEFAULT_CAPABILITIES,
    ...(config.extraCapabilities ?? []),
  ];

  const opportunities: Opportunity[] = raw.map((issue) => {
    const labels = issue.labels.map((l) => l.name);
    const repo = repoFromUrl(issue.repository_url);
    const opp: Opportunity = {
      id: `gh-scan-${repo.replace("/", "-")}-${issue.number}`,
      source: "github",
      title: issue.title,
      description: (issue.body || "").slice(0, 500),
      url: issue.html_url,
      repo,
      labels,
      estimatedEffort: complexityEstimate(labels) >= 0.85 ? "small" : "medium",
      matchScore: 0,
      status: "found",
      bountyValue: extractBountyValue(issue.body) > 0
        ? `$${extractBountyValue(issue.body)}`
        : undefined,
      createdAt: issue.created_at,
    };

    // Evaluate with capability matcher
    const capResult = evaluateOpportunity(opp, capabilities);
    const finalScore = scoreIssue(issue, capResult.matchScore);
    opp.matchScore = Math.round(finalScore * 100) / 100;
    opp.status = capResult.canDo ? "evaluated" : "rejected";

    return opp;
  });

  // Sort descending by score, filter out rejected
  return opportunities
    .filter((o) => o.status !== "rejected")
    .sort((a, b) => b.matchScore - a.matchScore);
}

// ---------------------------------------------------------------------------
// Daily digest
// ---------------------------------------------------------------------------

export interface DailyDigest {
  generatedAt: string;
  totalScanned: number;
  opportunities: Opportunity[];
}

/**
 * Generate a daily digest of top N opportunities.
 * Suitable for logging, Telegram notification, or daemon cron output.
 */
export async function dailyDigest(
  config: IssueScannerConfig = {}
): Promise<DailyDigest> {
  const digestSize = config.digestSize ?? 5;
  const all = await scanIssues(config);

  return {
    generatedAt: new Date().toISOString(),
    totalScanned: all.length,
    opportunities: all.slice(0, digestSize),
  };
}

/**
 * Format digest as a plain-text summary (for CLI or Telegram).
 */
export function formatDigest(digest: DailyDigest): string {
  const lines: string[] = [
    `--- 8gent Issue Scanner Digest ---`,
    `Generated: ${digest.generatedAt}`,
    `Scanned: ${digest.totalScanned} issues | Showing top ${digest.opportunities.length}`,
    ``,
  ];

  for (const [i, opp] of digest.opportunities.entries()) {
    const bounty = opp.bountyValue ? ` [${opp.bountyValue}]` : "";
    lines.push(`${i + 1}. [${opp.matchScore}] ${opp.title}${bounty}`);
    lines.push(`   ${opp.repo} | ${opp.estimatedEffort} | ${opp.labels.slice(0, 3).join(", ")}`);
    lines.push(`   ${opp.url}`);
    lines.push(``);
  }

  if (digest.opportunities.length === 0) {
    lines.push("No matching opportunities found today.");
  }

  return lines.join("\n");
}
