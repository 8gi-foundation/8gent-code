/**
 * 8gent Browser - Fetch Page
 *
 * HTTP fetch + text extraction. No external HTML deps.
 * Caches results for 1 hour.
 */

import { htmlToText } from "./html-to-text";
import { cacheGet, cacheSet } from "./cache";

export interface PageResult {
  title: string;
  text: string;
  links: string[];
  url: string;
  cached: boolean;
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * Fetch a URL and return readable text, title, and links.
 * Cached for 1 hour by default.
 */
export async function fetchPage(url: string): Promise<PageResult> {
  // Normalize
  const normalized = url.startsWith("http") ? url : `https://${url}`;

  // Cache hit
  const cached = cacheGet<PageResult>(normalized);
  if (cached) return { ...cached, cached: true };

  const res = await fetch(normalized, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
    },
    redirect: "follow",
  });

  if (!res.ok) {
    throw new Error(`fetchPage ${res.status} ${res.statusText} — ${normalized}`);
  }

  const contentType = res.headers.get("content-type") ?? "";

  // Non-HTML: return raw text
  if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
    const text = (await res.text()).slice(0, 50_000);
    const result: PageResult = { title: normalized, text, links: [], url: res.url, cached: false };
    cacheSet(normalized, result);
    return result;
  }

  const html = await res.text();
  const { title, text, links } = htmlToText(html);

  const result: PageResult = {
    title: title || normalized,
    text,
    links,
    url: res.url,
    cached: false,
  };

  cacheSet(normalized, result);
  return result;
}
