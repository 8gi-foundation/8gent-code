/**
 * 8gent Code - Web Tools
 *
 * Web search and fetch utilities using DuckDuckGo HTML API
 * and Readability for content extraction.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readability } from "@mozilla/readability";
import * as cheerio from "cheerio";
import { dotenvCandidates, dotenvDeclaredKeys } from "../permissions/run-command-sandbox";
import {
	type FetchImpl,
	type NetDeps,
	guardedFetch,
	normalizeOrigin,
	searchEndpointFetch,
} from "./net-guard";
// jsdom is imported on first use: at import time it reads its default stylesheet
// from its own install path, which does not exist inside a compiled binary.

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
	/** Test seam: replaces the snapshotted EIGHT_SEARCH_URL. Product code never sets it. */
	searchUrl?: string;
	/** Test seam: fetch used for the configured search endpoint. */
	fetchImpl?: FetchImpl;
	/** Test seam: where search origins are logged. Default ~/.8gent/search-origins.jsonl. */
	originLog?: string;
	/** Test seam: receives the once-per-session notice. Default console.error. */
	notify?: (line: string) => void;
}

export interface WebFetchOptions {
	maxLength?: number;
	extractMain?: boolean;
	/** DNS and fetch seams for tests. Production uses the system resolver and fetch. */
	net?: NetDeps;
}

// ============================================
// Configured search endpoint (#4613)
// ============================================

/**
 * Pure: EIGHT_SEARCH_URL counts only when it came from the real process
 * environment. A value any .env file declares is dropped, whatever it says, so
 * a cloned project cannot steer searches (or the guard exemption) to a host of
 * its choosing. Same rule as securityEnvSnapshot in packages/permissions; the key
 * is read here because packages/permissions is not touched by this change.
 */
export function resolveSearchUrl(
	value: string | undefined,
	declared: Set<string>,
): string | undefined {
	if (!value || declared.has("EIGHT_SEARCH_URL")) return undefined;
	return normalizeOrigin(value) ? value : undefined;
}

/** Pure: true when a value was set but dropped because a .env file declares the key. */
export function searchUrlDroppedByDotenv(
	value: string | undefined,
	declared: Set<string>,
): boolean {
	return !!value && declared.has("EIGHT_SEARCH_URL");
}

// Captured at module load, before the TUI's loadEnvFile() can add anything.
const declaredAtStart = dotenvDeclaredKeys(dotenvCandidates());
const searchUrlAtStart = resolveSearchUrl(process.env.EIGHT_SEARCH_URL, declaredAtStart);
const droppedAtStart = searchUrlDroppedByDotenv(process.env.EIGHT_SEARCH_URL, declaredAtStart);

export const SEARCH_IGNORED_NOTICE =
	"EIGHT_SEARCH_URL ignored: declared in a .env file. Set it in your shell profile.";

/** True when EIGHT_SEARCH_URL was set but ignored because a .env file declares it. */
export function searchUrlIgnored(): boolean {
	return droppedAtStart;
}

// ---- Where each search went (origin only, never the query) ----
// PR #4614's ~/.8gent/locality.jsonl is not on main, so this is a small separate log.

export function searchOriginLogPath(): string {
	return path.join(os.homedir(), ".8gent", "search-origins.jsonl");
}

function recordSearchOrigin(origin: string, logPath?: string): void {
	try {
		const file = logPath ?? searchOriginLogPath();
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), origin })}\n`);
	} catch {}
}

/** Counts of destination origins from the last `limit` logged searches. */
export function readSearchOrigins(logPath?: string, limit = 200): Record<string, number> {
	const counts: Record<string, number> = {};
	try {
		const lines = fs
			.readFileSync(logPath ?? searchOriginLogPath(), "utf8")
			.trim()
			.split("\n");
		for (const line of lines.slice(-limit)) {
			try {
				const o = (JSON.parse(line) as { origin?: unknown }).origin;
				if (typeof o === "string") counts[o] = (counts[o] ?? 0) + 1;
			} catch {}
		}
	} catch {}
	return counts;
}

let noticed = false;
function noticeOnce(options: WebSearchOptions): void {
	if (noticed || !droppedAtStart) return;
	noticed = true;
	(options.notify ?? ((l: string) => console.error(`[web] ${l} Searching via duckduckgo.`)))(
		SEARCH_IGNORED_NOTICE,
	);
}
/** Tests only. */
export function resetSearchNoticeForTests(): void {
	noticed = false;
}

/** The configured search endpoint URL, or undefined when search uses DuckDuckGo. */
export function configuredSearchUrl(): string | undefined {
	return searchUrlAtStart;
}

/** Strip control characters (terminal escapes, newlines in titles) and bound length. */
function cleanText(value: unknown, max: number): string {
	if (typeof value !== "string") return "";
	return value
		.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, max);
}

/** Map a SearXNG-style JSON body to SearchResult[]. Entries without a title or http(s) url are dropped. */
export function mapSearchJson(body: string, maxResults: number): SearchResult[] {
	let data: unknown;
	try {
		data = JSON.parse(body);
	} catch {
		throw new Error("Search endpoint did not return JSON (is format=json enabled?).");
	}
	const list = (data as { results?: unknown })?.results;
	if (!Array.isArray(list)) throw new Error("Search endpoint JSON has no results array.");
	const out: SearchResult[] = [];
	for (const item of list) {
		if (out.length >= maxResults) break;
		const r = item as Record<string, unknown>;
		const title = cleanText(r?.title, 300);
		const url = cleanText(r?.url, 2000);
		if (!title || !normalizeOrigin(url)) continue;
		out.push({ title, url, snippet: cleanText(r.content ?? r.snippet, 1000) });
	}
	return out;
}

async function searchConfigured(
	endpoint: string,
	query: string,
	options: WebSearchOptions,
): Promise<SearchResult[]> {
	const maxResults = options.maxResults || 10;
	const url = new URL(endpoint);
	url.searchParams.set("q", query);
	url.searchParams.set("format", "json");
	let body: string;
	try {
		body = await searchEndpointFetch(url.href, endpoint, { fetchImpl: options.fetchImpl });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		// No silent fallback to the public site: that would send the query out
		// exactly when the operator asked for it to stay in.
		throw new Error(`Search endpoint ${url.origin} failed: ${msg}`);
	}
	return mapSearchJson(body, maxResults);
}

/** For `8gent doctor`: null when unconfigured, else whether the endpoint answers a query. */
export async function probeSearchEndpoint(
	options: WebSearchOptions = {},
): Promise<{ origin: string; ok: boolean; detail?: string } | null> {
	const endpoint = options.searchUrl ?? configuredSearchUrl();
	if (!endpoint) return null;
	const origin = new URL(endpoint).origin;
	try {
		await searchConfigured(endpoint, "8gent", { ...options, maxResults: 1 });
		return { origin, ok: true };
	} catch (err) {
		return { origin, ok: false, detail: err instanceof Error ? err.message : String(err) };
	}
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
	options: WebSearchOptions = {},
): Promise<SearchResult[]> {
	const maxResults = options.maxResults || 10;

	const endpoint = options.searchUrl ?? configuredSearchUrl();
	if (endpoint) {
		recordSearchOrigin(new URL(endpoint).origin, options.originLog);
		return searchConfigured(endpoint, query, options);
	}
	noticeOnce(options);
	recordSearchOrigin("duckduckgo", options.originLog);

	// Use DuckDuckGo HTML lite endpoint
	const params = new URLSearchParams({
		q: query,
		kl: options.region || "us-en",
	});

	const url = `https://html.duckduckgo.com/html/?${params.toString()}`;

	try {
		const response = await fetch(url, {
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
				Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
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
	options: WebFetchOptions = {},
): Promise<WebFetchResult> {
	const maxLength = options.maxLength || 50000;
	const extractMain = options.extractMain !== false;

	try {
		// Normalize URL
		let normalizedUrl = url;
		if (!normalizedUrl.startsWith("http://") && !normalizedUrl.startsWith("https://")) {
			normalizedUrl = `https://${normalizedUrl}`;
		}

		// guardedFetch refuses loopback, private, link-local and metadata
		// destinations, pins the connection to the checked address, and re-checks
		// every redirect hop (#3233).
		const { response, finalUrl } = await guardedFetch(
			normalizedUrl,
			{
				headers: {
					"User-Agent":
						"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
					Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
					"Accept-Language": "en-US,en;q=0.5",
				},
			},
			options.net,
		);

		if (!response.ok) {
			throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
		}

		const contentType = response.headers.get("content-type") || "";

		// Handle non-HTML content
		if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
			const text = await response.text();
			return {
				title: normalizedUrl,
				url: finalUrl,
				content: text.slice(0, maxLength),
				length: text.length,
			};
		}

		const html = await response.text();

		if (extractMain) {
			// Use Readability for main content extraction
			const { JSDOM } = await import("jsdom");
			const dom = new JSDOM(html, { url: finalUrl });
			const reader = new Readability(dom.window.document);
			const article = reader.parse();

			if (article) {
				// Convert HTML content to markdown-ish format
				const content = htmlToMarkdown(article.content || "");

				return {
					title: article.title || normalizedUrl,
					url: finalUrl,
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
			url: finalUrl,
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
		.replace(/\n{3,}/g, "\n\n") // Multiple newlines to double
		.replace(/[ \t]+/g, " ") // Multiple spaces to single
		.replace(/^\s+|\s+$/gm, "") // Trim lines
		.trim();

	return text;
}

// ============================================
// Summarization (Simple)
// ============================================

/**
 * Create a simple extractive summary of content
 */
export function summarizeContent(content: string, maxSentences = 5): string {
	// Split into sentences
	const sentences = content
		.split(/[.!?]+/)
		.map((s) => s.trim())
		.filter((s) => s.length > 20);

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
	options: { maxResults?: number; summarizeResults?: boolean } = {},
): Promise<{
	query: string;
	results: Array<SearchResult & { summary?: string }>;
}> {
	const searchResults = await webSearch(query, {
		maxResults: options.maxResults || 5,
	});

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
		}),
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
