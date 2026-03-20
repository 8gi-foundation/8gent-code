/**
 * @8gent/telegram-bot — GitHub Intelligence Gathering
 *
 * Nightly system that scrapes GitHub trending repos, scores relevance to 8gent,
 * maintains a persistent knowledge base, and generates Telegram digests.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ── Types ───────────────────────────────────────────────

export interface TrendingRepo {
  url: string;
  name: string;
  fullName: string;
  description: string;
  stars: number;
  language: string;
  pushedAt: string;
  createdAt: string;
  topics: string[];
  owner: string;
  hasReadme: boolean;
}

export interface RepoEntry {
  url: string;
  name: string;
  description: string;
  stars: number;
  language: string;
  relevanceScore: number;
  discoveredAt: string;
  categories: string[];
  keyFeatures: string[];
  status: "new" | "reviewed" | "integrated" | "irrelevant";
  previousStars?: number;
  lastUpdated: string;
}

interface IntelligenceDigest {
  date: string;
  scanned: number;
  relevant: number;
  newDiscoveries: number;
  repos: RepoEntry[];
  trendingUp: { name: string; starDelta: number }[];
  totalTracked: number;
}

// ── Constants ───────────────────────────────────────────

const HOME = homedir();
const INTEL_DIR = join(HOME, ".8gent/intelligence");
const REPOS_FILE = join(INTEL_DIR, "repos.json");
const DIGEST_FILE = join(INTEL_DIR, "latest-digest.json");
const GITHUB_API = "https://api.github.com";
const MIN_RELEVANCE_SCORE = 5;

// ── GitHub Intelligence Class ───────────────────────────

export class GitHubIntelligence {
  private knowledgeBase: RepoEntry[] = [];

  constructor() {
    this.ensureDirectories();
    this.loadKnowledgeBase();
  }

  // ── Directory & Persistence ─────────────────────────

  private ensureDirectories(): void {
    if (!existsSync(INTEL_DIR)) {
      mkdirSync(INTEL_DIR, { recursive: true });
    }
  }

  private loadKnowledgeBase(): void {
    try {
      if (existsSync(REPOS_FILE)) {
        this.knowledgeBase = JSON.parse(readFileSync(REPOS_FILE, "utf-8"));
      }
    } catch {
      this.knowledgeBase = [];
    }
  }

  private saveKnowledgeBase(): void {
    writeFileSync(REPOS_FILE, JSON.stringify(this.knowledgeBase, null, 2));
  }

  private saveDigest(digest: IntelligenceDigest): void {
    writeFileSync(DIGEST_FILE, JSON.stringify(digest, null, 2));
  }

  // ── GitHub API ──────────────────────────────────────

  /**
   * Fetch trending/search results from GitHub search API.
   * Uses native fetch with public endpoints (no auth needed for basic search).
   * Falls back to `gh` CLI for authenticated requests if rate-limited.
   */
  async fetchTrending(
    query: string,
    sort: "stars" | "updated",
    limit: number = 30
  ): Promise<TrendingRepo[]> {
    const perPage = Math.min(limit, 100);
    const url = `${GITHUB_API}/search/repositories?q=${encodeURIComponent(query)}&sort=${sort}&order=desc&per_page=${perPage}`;

    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "8gent-intelligence/1.0",
        },
      });

      if (response.status === 403 || response.status === 429) {
        // Rate limited — try gh CLI fallback
        return this.fetchTrendingViaCli(query, sort, limit);
      }

      if (!response.ok) {
        console.error(`[intel] GitHub API error: ${response.status} ${response.statusText}`);
        return [];
      }

      const data = (await response.json()) as any;
      return (data.items || []).map(this.mapGitHubRepo);
    } catch (err: any) {
      console.error(`[intel] Fetch error: ${err.message}`);
      return this.fetchTrendingViaCli(query, sort, limit);
    }
  }

  private async fetchTrendingViaCli(
    query: string,
    sort: "stars" | "updated",
    limit: number
  ): Promise<TrendingRepo[]> {
    try {
      const proc = Bun.spawn(
        ["gh", "api", "search/repositories", "-f", `q=${query}`, "-f", `sort=${sort}`, "-f", "order=desc", "-f", `per_page=${Math.min(limit, 100)}`],
        { stdout: "pipe", stderr: "pipe" }
      );

      const text = await new Response(proc.stdout).text();
      const data = JSON.parse(text);
      return (data.items || []).map(this.mapGitHubRepo);
    } catch (err: any) {
      console.error(`[intel] gh CLI fallback failed: ${err.message}`);
      return [];
    }
  }

  private mapGitHubRepo(item: any): TrendingRepo {
    return {
      url: item.html_url,
      name: item.name,
      fullName: item.full_name,
      description: item.description || "",
      stars: item.stargazers_count,
      language: item.language || "unknown",
      pushedAt: item.pushed_at,
      createdAt: item.created_at,
      topics: item.topics || [],
      owner: item.owner?.login || "unknown",
      hasReadme: item.has_wiki || true,
    };
  }

  // ── Relevance Scoring ───────────────────────────────

  /**
   * Score a repo 1-10 for relevance to 8gent-code.
   */
  scoreRelevance(repo: TrendingRepo): { score: number; categories: string[] } {
    let score = 0;
    const categories: string[] = [];
    const text = `${repo.name} ${repo.description} ${repo.topics.join(" ")}`.toLowerCase();

    // Has "agent" or "claw" or "coding" in name/description -> +3
    if (/agent|claw|coding/.test(text)) {
      score += 3;
      if (/agent/.test(text)) categories.push("agent");
      if (/coding/.test(text)) categories.push("coding");
    }

    // TypeScript/JavaScript -> +2
    if (/typescript|javascript/i.test(repo.language)) {
      score += 2;
      categories.push("typescript");
    }

    // Has benchmarks/eval -> +2
    if (/benchmark|eval|harness|leaderboard|score/.test(text)) {
      score += 2;
      categories.push("benchmark");
    }

    // >100 stars -> +1
    if (repo.stars > 100) {
      score += 1;
    }

    // Active (pushed in last 7 days) -> +1
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    if (new Date(repo.pushedAt) > sevenDaysAgo) {
      score += 1;
    }

    // Has MCP/tool-use patterns -> +1
    if (/mcp|tool.?use|function.?call|tool.?call|plugin/.test(text)) {
      score += 1;
      categories.push("tool");
    }

    // Bonus categories from topics
    if (/llm|gpt|claude|openai|model/.test(text)) categories.push("llm");
    if (/framework/.test(text)) categories.push("framework");
    if (/cli|terminal|tui/.test(text)) categories.push("cli");
    if (/rl|reinforcement|fine.?tun/.test(text)) categories.push("training");

    // Ensure at least one category
    if (categories.length === 0) categories.push("general");

    // Clamp to 1-10
    return {
      score: Math.max(1, Math.min(10, score)),
      categories: [...new Set(categories)],
    };
  }

  /**
   * Extract key features from repo description and topics.
   */
  extractKeyFeatures(repo: TrendingRepo): string[] {
    const features: string[] = [];
    const desc = repo.description.toLowerCase();

    if (/typescript|ts/.test(desc) || repo.language === "TypeScript") features.push("TypeScript");
    if (/rust/.test(desc) || repo.language === "Rust") features.push("Rust");
    if (/python/.test(desc) || repo.language === "Python") features.push("Python");
    if (/benchmark|eval/.test(desc)) features.push("benchmarks");
    if (/agent/.test(desc)) features.push("agent-framework");
    if (/mcp/.test(desc)) features.push("MCP-compatible");
    if (/cli|terminal/.test(desc)) features.push("CLI");
    if (/llm|language model/.test(desc)) features.push("LLM");
    if (/open.?source/.test(desc)) features.push("open-source");
    if (/rl|reinforcement/.test(desc)) features.push("RL");
    if (/fine.?tun/.test(desc)) features.push("fine-tuning");
    if (/tool/.test(desc)) features.push("tool-use");
    if (/local|ollama/.test(desc)) features.push("local-models");
    if (/stream/.test(desc)) features.push("streaming");

    // Add top topics
    for (const topic of repo.topics.slice(0, 5)) {
      if (!features.includes(topic)) {
        features.push(topic);
      }
    }

    return features.slice(0, 8);
  }

  // ── Knowledge Base Management ───────────────────────

  /**
   * Add or update a repo in the knowledge base.
   * Returns true if this is a new addition.
   */
  upsertRepo(repo: TrendingRepo, score: number, categories: string[]): boolean {
    const existing = this.knowledgeBase.find((r) => r.url === repo.url);

    if (existing) {
      // Update star count and timestamp
      existing.previousStars = existing.stars;
      existing.stars = repo.stars;
      existing.lastUpdated = new Date().toISOString();
      // Re-score if categories changed
      if (categories.length > existing.categories.length) {
        existing.categories = categories;
        existing.relevanceScore = Math.max(existing.relevanceScore, score);
      }
      return false;
    }

    // New repo
    this.knowledgeBase.push({
      url: repo.url,
      name: repo.fullName,
      description: repo.description,
      stars: repo.stars,
      language: repo.language,
      relevanceScore: score,
      discoveredAt: new Date().toISOString(),
      categories,
      keyFeatures: this.extractKeyFeatures(repo),
      status: "new",
      lastUpdated: new Date().toISOString(),
    });

    return true;
  }

  // ── Nightly Intelligence Run ────────────────────────

  /**
   * Run the full nightly intelligence gathering pipeline.
   * Returns a formatted Telegram digest message.
   */
  async runNightlyIntelligence(): Promise<string> {
    console.log("[intel] Starting nightly intelligence run...");

    const allRepos: TrendingRepo[] = [];
    let scanned = 0;

    // 1. Fetch trending across categories (with delays to avoid rate limits)
    const searches = [
      { query: "stars:>50 pushed:>2026-03-01", sort: "stars" as const, label: "overall" },
      { query: "language:typescript stars:>20 pushed:>2026-03-01", sort: "stars" as const, label: "typescript" },
      { query: '"AI agent" OR "LLM" OR "coding agent" stars:>10 pushed:>2026-03-01', sort: "stars" as const, label: "ai-ml" },
      { query: '"developer tools" OR "dev tools" OR "CLI" stars:>20 pushed:>2026-03-01', sort: "stars" as const, label: "devtools" },
      { query: '"coding agent" OR "code assistant" OR "agentic" stars:>5 pushed:>2026-03-01', sort: "updated" as const, label: "agents" },
      { query: "MCP OR model-context-protocol stars:>5 pushed:>2026-03-01", sort: "updated" as const, label: "mcp" },
    ];

    for (const search of searches) {
      console.log(`[intel] Fetching: ${search.label}...`);
      const repos = await this.fetchTrending(search.query, search.sort, 30);
      allRepos.push(...repos);
      scanned += repos.length;

      // Small delay between requests to be polite
      await new Promise((r) => setTimeout(r, 2000));
    }

    // 2. Deduplicate fetched repos
    const seen = new Set<string>();
    const uniqueRepos: TrendingRepo[] = [];
    for (const repo of allRepos) {
      if (!seen.has(repo.url)) {
        seen.add(repo.url);
        uniqueRepos.push(repo);
      }
    }

    console.log(`[intel] Scanned ${scanned} results, ${uniqueRepos.length} unique repos`);

    // 3. Score and filter
    let relevant = 0;
    let newCount = 0;
    const newRepos: RepoEntry[] = [];

    for (const repo of uniqueRepos) {
      const { score, categories } = this.scoreRelevance(repo);

      if (score >= MIN_RELEVANCE_SCORE) {
        relevant++;
        const isNew = this.upsertRepo(repo, score, categories);
        if (isNew) {
          newCount++;
          const entry = this.knowledgeBase.find((r) => r.url === repo.url)!;
          newRepos.push(entry);
        }
      }
    }

    // 4. Calculate trending up (repos with star increases)
    const trendingUp: { name: string; starDelta: number }[] = [];
    for (const entry of this.knowledgeBase) {
      if (entry.previousStars !== undefined && entry.stars > entry.previousStars) {
        trendingUp.push({
          name: entry.name,
          starDelta: entry.stars - entry.previousStars,
        });
      }
    }
    trendingUp.sort((a, b) => b.starDelta - a.starDelta);

    // 5. Sort knowledge base by relevance
    this.knowledgeBase.sort((a, b) => b.relevanceScore - a.relevanceScore);

    // 6. Save
    this.saveKnowledgeBase();

    const digest: IntelligenceDigest = {
      date: new Date().toISOString().split("T")[0],
      scanned: uniqueRepos.length,
      relevant,
      newDiscoveries: newCount,
      repos: newRepos,
      trendingUp: trendingUp.slice(0, 5),
      totalTracked: this.knowledgeBase.length,
    };

    this.saveDigest(digest);

    console.log(`[intel] Done. ${relevant} relevant, ${newCount} new. ${this.knowledgeBase.length} total tracked.`);

    // 7. Format and return Telegram message
    return this.formatDigest(digest);
  }

  // ── Digest Formatting ───────────────────────────────

  /**
   * Format the intelligence digest as a Telegram message.
   */
  formatDigest(digest: IntelligenceDigest): string {
    const dateStr = new Date(digest.date).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });

    const lines: string[] = [];

    lines.push(`*NIGHTLY INTELLIGENCE -- ${dateStr}*`);
    lines.push("-------------------------------");
    lines.push("");
    lines.push(`Scanned: ${digest.scanned} repos | Relevant: ${digest.relevant} | New: ${digest.newDiscoveries}`);
    lines.push("");

    // New discoveries
    if (digest.repos.length > 0) {
      lines.push("*New Discoveries:*");
      for (const repo of digest.repos.slice(0, 8)) {
        const stars = repo.stars.toLocaleString();
        lines.push(`  ${stars} stars \`${repo.name}\` (${repo.relevanceScore}/10)`);
        if (repo.description) {
          lines.push(`  _${repo.description.slice(0, 100)}_`);
        }
        if (repo.keyFeatures.length > 0) {
          lines.push(`  Key: ${repo.keyFeatures.slice(0, 4).join(", ")}`);
        }
        lines.push("");
      }
    } else {
      lines.push("*New Discoveries:*");
      lines.push("  _No new repos above threshold today._");
      lines.push("");
    }

    // Trending up
    if (digest.trendingUp.length > 0) {
      lines.push("*Trending Up:*");
      for (const t of digest.trendingUp.slice(0, 5)) {
        lines.push(`  \`${t.name}\` +${t.starDelta} stars this week`);
      }
      lines.push("");
    }

    lines.push(`*Knowledge Base: ${digest.totalTracked} repos tracked*`);

    return lines.join("\n");
  }

  // ── Query Methods (for bot commands) ────────────────

  /**
   * Get the latest digest from disk.
   */
  getLatestDigest(): string {
    try {
      if (existsSync(DIGEST_FILE)) {
        const digest: IntelligenceDigest = JSON.parse(readFileSync(DIGEST_FILE, "utf-8"));
        return this.formatDigest(digest);
      }
    } catch {}
    return "*Intelligence*\n\n_No digest available yet. Run /trending or wait for the nightly scan._";
  }

  /**
   * Get tracked repos sorted by relevance score.
   */
  getTrackedRepos(limit: number = 15): string {
    if (this.knowledgeBase.length === 0) {
      return "*Tracked Repos*\n\n_Knowledge base is empty. Run /trending to populate._";
    }

    const sorted = [...this.knowledgeBase]
      .filter((r) => r.status !== "irrelevant")
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, limit);

    const lines: string[] = [
      `*Tracked Repos* (${this.knowledgeBase.length} total)`,
      "-------------------------------",
      "",
    ];

    for (const repo of sorted) {
      const statusIcon =
        repo.status === "new" ? "[NEW]" :
        repo.status === "reviewed" ? "[OK]" :
        repo.status === "integrated" ? "[INT]" : "";

      lines.push(
        `${statusIcon} \`${repo.name}\` (${repo.relevanceScore}/10) ${repo.stars.toLocaleString()} stars`
      );
      lines.push(`  ${repo.categories.join(", ")} | ${repo.language}`);
    }

    return lines.join("\n");
  }

  /**
   * Run an ad-hoc trending scan (lighter than nightly).
   */
  async runQuickScan(): Promise<string> {
    console.log("[intel] Running quick trending scan...");

    const repos = await this.fetchTrending(
      '"AI agent" OR "coding agent" OR "LLM" stars:>10 pushed:>2026-03-01',
      "stars",
      20
    );

    let newCount = 0;
    for (const repo of repos) {
      const { score, categories } = this.scoreRelevance(repo);
      if (score >= MIN_RELEVANCE_SCORE) {
        const isNew = this.upsertRepo(repo, score, categories);
        if (isNew) newCount++;
      }
    }

    this.saveKnowledgeBase();

    const lines: string[] = [
      "*Quick Trending Scan*",
      "-------------------------------",
      "",
      `Scanned: ${repos.length} repos`,
      `New discoveries: ${newCount}`,
      `Total tracked: ${this.knowledgeBase.length}`,
      "",
    ];

    if (newCount > 0) {
      lines.push("*Newly added:*");
      const newRepos = this.knowledgeBase
        .filter((r) => r.status === "new")
        .sort((a, b) => b.relevanceScore - a.relevanceScore)
        .slice(0, 5);

      for (const repo of newRepos) {
        lines.push(`  \`${repo.name}\` (${repo.relevanceScore}/10) ${repo.stars} stars`);
      }
    } else {
      lines.push("_No new repos above threshold._");
    }

    return lines.join("\n");
  }
}
