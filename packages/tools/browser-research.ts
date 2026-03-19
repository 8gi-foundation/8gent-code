/**
 * Browser-based research tools for 8gent.
 * Combines browser automation with knowledge extraction.
 */

import { BrowserTools } from "./browser-tools";

// ============================================
// Types
// ============================================

export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
}

export interface RepoAnalysis {
  name: string;
  description: string;
  stars: number;
  language: string;
  readme: string;
  topics: string[];
}

export interface TestResult {
  route: string;
  status: string;
  screenshot: string;
  textLength: number;
}

// ============================================
// BrowserResearch class
// ============================================

export class BrowserResearch {
  private browser: BrowserTools;

  constructor() {
    this.browser = new BrowserTools({ timeout: 60000 });
  }

  /** Check if agent-browser is available on the system */
  isAvailable(): boolean {
    return this.browser.isAvailable();
  }

  /** Search the web and extract results */
  async webSearch(query: string): Promise<SearchResult[]> {
    this.browser.open(
      `https://www.google.com/search?q=${encodeURIComponent(query)}`,
    );
    const text = this.browser.text();
    return this.parseSearchResults(text);
  }

  /** Open a GitHub repo and extract key info */
  async analyzeGitHubRepo(url: string): Promise<RepoAnalysis> {
    this.browser.open(url);
    const text = this.browser.text();
    const snapshot = this.browser.snapshot();

    // Extract repo name from URL
    const urlParts = url.replace(/\/$/, "").split("/");
    const name = urlParts.slice(-2).join("/");

    // Extract description from snapshot elements
    const descEl = snapshot.elements.find(
      (e) => e.role === "heading" || e.name.length > 30,
    );
    const description = descEl?.name ?? "";

    // Extract star count from text
    const starsMatch = text.match(/([\d,.]+)\s*stars?/i);
    const stars = starsMatch
      ? parseInt(starsMatch[1].replace(/[,.]/g, ""), 10)
      : 0;

    // Extract language
    const langMatch = text.match(
      /(?:^|\n)(TypeScript|JavaScript|Python|Rust|Go|Java|C\+\+|Ruby|Swift|Kotlin)/m,
    );
    const language = langMatch?.[1] ?? "";

    // Extract topics from text (GitHub shows them as links)
    const topicMatches = text.match(/Topics?:?\s*([^\n]+)/i);
    const topics = topicMatches
      ? topicMatches[1].split(/\s+/).filter((t) => t.length > 2)
      : [];

    return {
      name,
      description,
      stars,
      language,
      readme: text.slice(0, 5000),
      topics,
    };
  }

  /** Read documentation from a URL and return extracted text */
  async readDocs(url: string): Promise<string> {
    this.browser.open(url);
    return this.browser.text();
  }

  /** Take a screenshot of a web page for visual reference */
  async captureReference(url: string, savePath: string): Promise<string> {
    this.browser.open(url);
    this.browser.screenshot(savePath);
    return savePath;
  }

  /** Test a local dev server by visiting routes and capturing results */
  async testLocalServer(
    port: number,
    routes: string[],
  ): Promise<TestResult[]> {
    const results: TestResult[] = [];

    for (const route of routes) {
      this.browser.open(`http://localhost:${port}${route}`);
      const text = this.browser.text();
      const screenshotPath = `/tmp/8gent-test-${route.replace(/\//g, "-") || "root"}.png`;
      this.browser.screenshot(screenshotPath);

      results.push({
        route,
        status: text.length > 0 ? "ok" : "empty",
        screenshot: screenshotPath,
        textLength: text.length,
      });
    }

    return results;
  }

  /** Close the underlying browser session */
  close(): void {
    this.browser.close();
  }

  // ============================================
  // Private helpers
  // ============================================

  private parseSearchResults(text: string): SearchResult[] {
    const results: SearchResult[] = [];
    const lines = text.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith("http") && line.includes("://")) {
        results.push({
          url: line,
          title: lines[i - 1]?.trim() || "",
          snippet: lines[i + 1]?.trim() || "",
        });
      }
    }

    return results.slice(0, 10);
  }
}
