/**
 * 8gent Browser Ability
 *
 * Lightweight web access: fetch + search with zero external HTML deps.
 * - fetchPage: HTTP fetch + text extraction, 1-hour disk cache
 * - webSearch: DuckDuckGo HTML scraping, no API key
 * - htmlToText: pure-regex HTML stripper
 * - cacheGet/cacheSet: SHA256-keyed disk cache (~/.8gent/browser-cache/)
 */

export { fetchPage } from "./fetch-page";
export type { PageResult } from "./fetch-page";

export { webSearch } from "./web-search";
export type { SearchResult } from "./web-search";

export { htmlToText } from "./html-to-text";

export { cacheGet, cacheSet } from "./cache";
