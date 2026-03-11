/**
 * 8gent Code - Web Tools
 *
 * Web search and fetch utilities using DuckDuckGo HTML API
 * and Readability for content extraction.
 */

import * as cheerio from "cheerio";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";

// ============================================
// Types
// ============================================

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebFetchResult {
  title: string;
  url: string;
  content: string;
  excerpt?: string;
  byline?: string;
  length: number;
}

export interface WebSearchOptions {
  maxResults?: number;
  region?: string;
}

export interface WebFetchOptions {
  maxLength?: number;
  extractMain?: boolean;
}

// ============================================
// DuckDuckGo Search
// ============================================

/**
 * Search the web using DuckDuckGo HTML API
 * No API key needed - uses the lite HTML version
 */
export async function webSearch(
  query: string,
  options: WebSearchOptions = {}
): Promise<SearchResult[]> {
  const maxResults = options.maxResults || 10;

  // Use DuckDuckGo HTML lite endpoint
  const params = new URLSearchParams({
    q: query,
    kl: options.region || "us-en",
  });

  const url = `https://html.duckduckgo.com/html/?${params.toString()}`;

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
    });

    if (!response.ok) {
      throw new Error(`Search failed: ${response.status} ${response.statusText}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    const results: SearchResult[] = [];

    // Parse DuckDuckGo results
    $(".result").each((_, element) => {
      if (results.length >= maxResults) return false;

      const $el = $(element);
      const titleEl = $el.find(".result__title a");
      const snippetEl = $el.find(".result__snippet");

      const title = titleEl.text().trim();
      let href = titleEl.attr("href") || "";

      // DuckDuckGo wraps URLs in redirects, extract the actual URL
      if (href.includes("uddg=")) {
        const match = href.match(/uddg=([^&]+)/);
        if (match) {
          href = decodeURIComponent(match[1]);
        }
      }

      const snippet = snippetEl.text().trim();

      if (title && href) {
        results.push({
          title,
          url: href,
          snippet,
        });
      }
    });

    return results;
  } catch (err) {
    console.error(`[web] Search error: ${err}`);
    throw err;
  }
}

// ============================================
// Web Fetch
// ============================================

/**
 * Fetch a URL and extract its main content
 */
export async function webFetch(
  url: string,
  options: WebFetchOptions = {}
): Promise<WebFetchResult> {
  const maxLength = options.maxLength || 50000;
  const extractMain = options.extractMain !== false;

  try {
    // Normalize URL
    let normalizedUrl = url;
    if (!normalizedUrl.startsWith("http://") && !normalizedUrl.startsWith("https://")) {
      normalizedUrl = `https://${normalizedUrl}`;
    }

    const response = await fetch(normalizedUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
      redirect: "follow",
    });

    if (!response.ok) {
      throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get("content-type") || "";

    // Handle non-HTML content
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      const text = await response.text();
      return {
        title: normalizedUrl,
        url: response.url,
        content: text.slice(0, maxLength),
        length: text.length,
      };
    }

    const html = await response.text();

    if (extractMain) {
      // Use Readability for main content extraction
      const dom = new JSDOM(html, { url: response.url });
      const reader = new Readability(dom.window.document);
      const article = reader.parse();

      if (article) {
        // Convert HTML content to markdown-ish format
        const content = htmlToMarkdown(article.content || "");

        return {
          title: article.title || normalizedUrl,
          url: response.url,
          content: content.slice(0, maxLength),
          excerpt: article.excerpt || undefined,
          byline: article.byline || undefined,
          length: content.length,
        };
      }
    }

    // Fallback: basic HTML parsing
    const content = htmlToMarkdown(html);

    // Try to extract title
    const $ = cheerio.load(html);
    const title = $("title").text().trim() || $("h1").first().text().trim() || normalizedUrl;

    return {
      title,
      url: response.url,
      content: content.slice(0, maxLength),
      length: content.length,
    };
  } catch (err) {
    console.error(`[web] Fetch error: ${err}`);
    throw err;
  }
}

// ============================================
// HTML to Markdown Conversion
// ============================================

/**
 * Convert HTML to a simplified markdown format
 */
function htmlToMarkdown(html: string): string {
  const $ = cheerio.load(html);

  // Remove scripts, styles, and other non-content elements
  $("script, style, nav, footer, header, aside, .sidebar, .advertisement, .ad, .ads").remove();

  // Convert common elements
  $("h1").each((_, el) => {
    const $el = $(el);
    $el.replaceWith(`\n# ${$el.text().trim()}\n`);
  });

  $("h2").each((_, el) => {
    const $el = $(el);
    $el.replaceWith(`\n## ${$el.text().trim()}\n`);
  });

  $("h3").each((_, el) => {
    const $el = $(el);
    $el.replaceWith(`\n### ${$el.text().trim()}\n`);
  });

  $("h4, h5, h6").each((_, el) => {
    const $el = $(el);
    $el.replaceWith(`\n#### ${$el.text().trim()}\n`);
  });

  $("p").each((_, el) => {
    const $el = $(el);
    $el.replaceWith(`\n${$el.text().trim()}\n`);
  });

  $("li").each((_, el) => {
    const $el = $(el);
    $el.replaceWith(`- ${$el.text().trim()}\n`);
  });

  $("pre, code").each((_, el) => {
    const $el = $(el);
    $el.replaceWith(`\n\`\`\`\n${$el.text().trim()}\n\`\`\`\n`);
  });

  $("a").each((_, el) => {
    const $el = $(el);
    const href = $el.attr("href");
    const text = $el.text().trim();
    if (href && text) {
      $el.replaceWith(`[${text}](${href})`);
    }
  });

  $("strong, b").each((_, el) => {
    const $el = $(el);
    $el.replaceWith(`**${$el.text().trim()}**`);
  });

  $("em, i").each((_, el) => {
    const $el = $(el);
    $el.replaceWith(`*${$el.text().trim()}*`);
  });

  $("br").replaceWith("\n");

  // Get text and clean up
  let text = $.text();

  // Clean up whitespace
  text = text
    .replace(/\n{3,}/g, "\n\n")  // Multiple newlines to double
    .replace(/[ \t]+/g, " ")      // Multiple spaces to single
    .replace(/^\s+|\s+$/gm, "")   // Trim lines
    .trim();

  return text;
}

// ============================================
// Summarization (Simple)
// ============================================

/**
 * Create a simple extractive summary of content
 */
export function summarizeContent(content: string, maxSentences: number = 5): string {
  // Split into sentences
  const sentences = content
    .split(/[.!?]+/)
    .map(s => s.trim())
    .filter(s => s.length > 20);

  // Take first N sentences as summary
  const summary = sentences.slice(0, maxSentences).join(". ");

  return summary + (sentences.length > maxSentences ? "..." : ".");
}

// ============================================
// Convenience Functions
// ============================================

/**
 * Search and summarize: combines search with content fetch
 */
export async function searchAndSummarize(
  query: string,
  options: { maxResults?: number; summarizeResults?: boolean } = {}
): Promise<{
  query: string;
  results: Array<SearchResult & { summary?: string }>;
}> {
  const searchResults = await webSearch(query, { maxResults: options.maxResults || 5 });

  if (!options.summarizeResults) {
    return { query, results: searchResults };
  }

  // Fetch and summarize each result
  const enrichedResults = await Promise.all(
    searchResults.map(async (result) => {
      try {
        const fetched = await webFetch(result.url, { maxLength: 10000 });
        const summary = summarizeContent(fetched.content, 3);
        return { ...result, summary };
      } catch {
        return result;
      }
    })
  );

  return { query, results: enrichedResults };
}

/**
 * Format search results for display
 */
export function formatSearchResults(results: SearchResult[]): string {
  return results
    .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`)
    .join("\n\n");
}

/**
 * Format web fetch result for display
 */
export function formatFetchResult(result: WebFetchResult): string {
  let output = `# ${result.title}\n\n`;

  if (result.byline) {
    output += `*${result.byline}*\n\n`;
  }

  if (result.excerpt) {
    output += `> ${result.excerpt}\n\n`;
  }

  output += result.content;

  if (result.length > result.content.length) {
    output += `\n\n[Content truncated - ${result.length} total characters]`;
  }

  return output;
}
