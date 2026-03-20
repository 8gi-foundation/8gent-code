/**
 * 8gent Browser - Web Search
 *
 * DuckDuckGo HTML scraping. No API key. Rate-limited to 1 req/sec.
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Simple rate limiter: 1 req/second
let lastSearchAt = 0;
async function rateLimit() {
  const gap = Date.now() - lastSearchAt;
  if (gap < 1000) await new Promise(r => setTimeout(r, 1000 - gap));
  lastSearchAt = Date.now();
}

/**
 * Search via DuckDuckGo HTML endpoint. Free, no API key required.
 */
export async function webSearch(query: string, maxResults = 10): Promise<SearchResult[]> {
  await rateLimit();

  const params = new URLSearchParams({ q: query, kl: "us-en" });
  const url = `https://html.duckduckgo.com/html/?${params}`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
    },
  });

  if (!res.ok) throw new Error(`webSearch failed: ${res.status} ${res.statusText}`);

  const html = await res.text();
  return parseResults(html, maxResults);
}

// ---------------------------------------------------------------------------
// Parser — zero external deps
// ---------------------------------------------------------------------------

function parseResults(html: string, max: number): SearchResult[] {
  const results: SearchResult[] = [];

  // DuckDuckGo HTML wraps each result in <div class="result ...">
  // We pull out result blocks, then extract title/url/snippet from each.
  const blockRe = /<div[^>]+class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
  let block: RegExpExecArray | null;

  while ((block = blockRe.exec(html)) !== null && results.length < max) {
    const chunk = block[1];

    // Title + URL from <a class="result__a" href="...">text</a>
    const anchorMatch = chunk.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!anchorMatch) continue;

    let rawUrl = anchorMatch[1];
    // DDG wraps URLs: /l/?uddg=<encoded>&...
    const uddgMatch = rawUrl.match(/[?&]uddg=([^&]+)/);
    if (uddgMatch) rawUrl = decodeURIComponent(uddgMatch[1]);

    const title = stripTags(anchorMatch[2]).trim();
    if (!title || !rawUrl) continue;

    // Snippet from <a class="result__snippet">...</a>
    const snippetMatch = chunk.match(/<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    const snippet = snippetMatch ? stripTags(snippetMatch[1]).trim() : "";

    results.push({ title, url: rawUrl, snippet });
  }

  return results;
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
