#!/usr/bin/env bun
/**
 * Social Feed Research Pipeline
 *
 * Browses James's social feeds (LinkedIn, X, Threads) for patterns,
 * tools, and frameworks relevant to the 8gent ecosystem. Abstracts
 * findings through the quarantine process and creates GitHub issues
 * with JTBD-justified proposals.
 *
 * Modes:
 *   --local    Use Playwright with existing Chrome profile (default)
 *   --vessel   Use browser-use (Python) in container
 *   --dry-run  Print findings without creating issues
 *
 * Usage:
 *   bun run scripts/social-feed-research.ts
 *   bun run scripts/social-feed-research.ts --dry-run
 */

import { execSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const ROOT = path.resolve(import.meta.dir, "..");
const LOG_PATH = path.join(os.homedir(), ".8gent", "social-research.log");
const FINDINGS_DIR = path.join(os.homedir(), ".8gent", "social-findings");
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "5486040131";

// Parse args
const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const isVessel = args.includes("--vessel");
const maxFindings = parseInt(
	args.find((_, i, a) => a[i - 1] === "--max") || "20",
);

// Ensure dirs
fs.mkdirSync(FINDINGS_DIR, { recursive: true });

function log(msg: string) {
	const line = `[${new Date().toISOString()}] ${msg}`;
	console.log(line);
	fs.appendFileSync(LOG_PATH, line + "\n");
}

// ============================================
// Feed sources — what to browse
// ============================================

interface FeedSource {
	name: string;
	platform: "linkedin" | "x" | "threads";
	urls: string[];
	selectors: {
		/** CSS selector for individual post/item containers */
		post: string;
		/** CSS selector for post text content */
		text: string;
		/** CSS selector for links within posts */
		link: string;
		/** CSS selector for author name */
		author: string;
	};
}

const FEEDS: FeedSource[] = [
	{
		name: "LinkedIn Feed",
		platform: "linkedin",
		urls: ["https://www.linkedin.com/feed/"],
		selectors: {
			post: ".feed-shared-update-v2",
			text: ".feed-shared-text__text-view",
			link: "a[href*='http']",
			author: ".update-components-actor__name",
		},
	},
	{
		name: "LinkedIn Saved",
		platform: "linkedin",
		urls: ["https://www.linkedin.com/my-items/saved-posts/"],
		selectors: {
			post: ".reusable-search__result-container",
			text: ".feed-shared-text__text-view",
			link: "a[href*='http']",
			author: ".update-components-actor__name",
		},
	},
	{
		name: "X Feed",
		platform: "x",
		urls: ["https://x.com/home"],
		selectors: {
			post: "article[data-testid='tweet']",
			text: "[data-testid='tweetText']",
			link: "a[href*='http']",
			author: "[data-testid='User-Name']",
		},
	},
	{
		name: "X Bookmarks",
		platform: "x",
		urls: ["https://x.com/i/bookmarks"],
		selectors: {
			post: "article[data-testid='tweet']",
			text: "[data-testid='tweetText']",
			link: "a[href*='http']",
			author: "[data-testid='User-Name']",
		},
	},
	{
		name: "Threads Feed",
		platform: "threads",
		urls: ["https://www.threads.net/"],
		selectors: {
			post: "[class*='ThreadItem']",
			text: "[class*='BodyTextContainer']",
			link: "a[href*='http']",
			author: "[class*='UsernameText']",
		},
	},
	{
		name: "Threads Saved",
		platform: "threads",
		urls: ["https://www.threads.net/saved"],
		selectors: {
			post: "[class*='ThreadItem']",
			text: "[class*='BodyTextContainer']",
			link: "a[href*='http']",
			author: "[class*='UsernameText']",
		},
	},
];

// ============================================
// Relevance keywords — what we're looking for
// ============================================

const RELEVANCE_KEYWORDS = [
	// AI agent patterns
	"agent framework",
	"multi-agent",
	"tool use",
	"function calling",
	"agentic",
	"agent loop",
	"agent orchestration",
	"agent sandbox",
	"code agent",
	"coding agent",
	"autonomous agent",
	// Infrastructure patterns
	"harness",
	"sandbox",
	"isolation",
	"worktree",
	"spawn",
	"message bus",
	"event sourcing",
	"audit log",
	"append-only",
	// Model/inference
	"fine-tune",
	"lora",
	"qlora",
	"model serving",
	"inference",
	"ollama",
	"llama.cpp",
	"vllm",
	"openrouter",
	"groq",
	// Developer tools
	"cli tool",
	"developer tool",
	"code review",
	"ast",
	"language server",
	"lsp",
	"tree-sitter",
	"syntax",
	// Security
	"prompt injection",
	"jailbreak",
	"red team",
	"ai safety",
	"content policy",
	"guardrails",
	"alignment",
	// Product patterns
	"onboarding",
	"retention",
	"activation",
	"growth loop",
	"right friction",
	"progressive disclosure",
	// Specific tech
	"bun",
	"deno",
	"next.js",
	"vercel",
	"fly.io",
	"cloudflare workers",
	"websocket",
	"webrtc",
	"service worker",
	"pwa",
	// AAC / Accessibility (for 8gent Jr)
	"aac",
	"augmentative communication",
	"accessibility",
	"a11y",
	"assistive technology",
	"coppa",
	"child safety",
	// Ecosystem
	"mcp",
	"model context protocol",
	"claude code",
	"cursor",
	"windsurf",
	"cline",
	"open source ai",
];

// ============================================
// Pattern extraction — what to create issues for
// ============================================

interface Finding {
	title: string;
	source: string;
	platform: string;
	author: string;
	url: string;
	summary: string;
	relevanceScore: number;
	matchedKeywords: string[];
	/** Where this pattern could fit in our stack */
	targetRepo: string;
	/** JTBD: the job this pattern does */
	jtbd: string;
	/** Why we need it — plain English pitch */
	pitch: string;
	/** Estimated effort */
	effort: "trivial" | "small" | "medium" | "large";
	/** Can we rebuild it in <200 lines? */
	abstractable: boolean;
}

function scoreRelevance(text: string): { score: number; keywords: string[] } {
	const lower = text.toLowerCase();
	const matched = RELEVANCE_KEYWORDS.filter((k) => lower.includes(k));
	// Score: each keyword match = 10 points, max 100
	const score = Math.min(100, matched.length * 10);
	return { score, keywords: matched };
}

function classifyTarget(keywords: string[]): string {
	const keywordStr = keywords.join(" ");
	if (/agent|harness|sandbox|spawn|orchestr/.test(keywordStr))
		return "8gent-code";
	if (/aac|child|coppa|access|a11y/.test(keywordStr)) return "8gentjr";
	if (/onboard|growth|retention|activation/.test(keywordStr))
		return "8gent-world";
	if (/security|injection|jailbreak|safety|guardrail/.test(keywordStr))
		return "8gi-governance";
	if (/model|fine-tune|lora|inference|ollama/.test(keywordStr))
		return "8gent-code";
	return "8gent-code";
}

function estimateEffort(
	summary: string,
): "trivial" | "small" | "medium" | "large" {
	const len = summary.length;
	if (len < 200) return "trivial";
	if (len < 500) return "small";
	if (len < 1000) return "medium";
	return "large";
}

// ============================================
// Browser automation — Playwright (local mode)
// ============================================

async function browseWithPlaywright(): Promise<Finding[]> {
	log("Using Playwright with existing Chrome profile...");

	// Find Chrome user data directory
	const chromeProfile = path.join(
		os.homedir(),
		"Library/Application Support/Google/Chrome",
	);
	if (!fs.existsSync(chromeProfile)) {
		log("Chrome profile not found — skipping Playwright mode");
		return [];
	}

	const findings: Finding[] = [];

	for (const feed of FEEDS) {
		log(`Browsing: ${feed.name}`);

		for (const url of feed.urls) {
			try {
				// Use Playwright CDP to connect to running Chrome or launch with profile
				// We use a subprocess to avoid adding playwright as a direct dependency
				const scriptContent = `
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://localhost:9222').catch(() => null);
  if (!browser) {
    console.error('Chrome DevTools not available. Run Chrome with --remote-debugging-port=9222');
    process.exit(1);
  }
  const context = browser.contexts()[0];
  const page = await context.newPage();
  await page.goto('${url}', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Scroll to load more content
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await page.waitForTimeout(2000);
  }

  // Extract text content from posts
  const posts = await page.$$eval('${feed.selectors.post}', (els) => {
    return els.slice(0, 20).map(el => ({
      text: el.querySelector('${feed.selectors.text}')?.textContent?.trim() || el.textContent?.trim()?.slice(0, 500) || '',
      author: el.querySelector('${feed.selectors.author}')?.textContent?.trim() || '',
      links: Array.from(el.querySelectorAll('a[href]')).map(a => a.href).filter(h => h.startsWith('http')).slice(0, 3),
    }));
  });

  console.log(JSON.stringify(posts));
  await page.close();
})();
`;
				const tmpScript = `/tmp/.8gent-feed-${feed.platform}-${Date.now()}.cjs`;
				fs.writeFileSync(tmpScript, scriptContent);

				const result = spawnSync("node", [tmpScript], {
					encoding: "utf-8",
					timeout: 60000,
				});

				try {
					fs.unlinkSync(tmpScript);
				} catch {}

				if (result.status !== 0) {
					log(`  Failed: ${(result.stderr || "").slice(0, 200)}`);
					continue;
				}

				const posts = JSON.parse(result.stdout.trim() || "[]") as Array<{
					text: string;
					author: string;
					links: string[];
				}>;

				log(`  Found ${posts.length} posts`);

				for (const post of posts) {
					if (!post.text || post.text.length < 50) continue;

					const { score, keywords } = scoreRelevance(post.text);
					if (score < 20) continue; // Skip low-relevance posts

					findings.push({
						title: post.text.slice(0, 80).replace(/\n/g, " ") + "...",
						source: feed.name,
						platform: feed.platform,
						author: post.author,
						url: post.links[0] || url,
						summary: post.text.slice(0, 500),
						relevanceScore: score,
						matchedKeywords: keywords,
						targetRepo: classifyTarget(keywords),
						jtbd: "", // Will be filled by LLM analysis
						pitch: "", // Will be filled by LLM analysis
						effort: estimateEffort(post.text),
						abstractable: true,
					});
				}
			} catch (err) {
				log(`  Error browsing ${url}: ${err}`);
			}
		}
	}

	return findings;
}

// ============================================
// Browser automation — browser-use (vessel mode)
// ============================================

async function browseWithBrowserUse(): Promise<Finding[]> {
	log("Using browser-use (Python) in vessel container...");

	const findings: Finding[] = [];

	// browser-use is a Python library, so we call it via subprocess
	for (const feed of FEEDS) {
		log(`Browsing: ${feed.name}`);

		const pythonScript = `
import asyncio
import json
from browser_use import Agent

async def main():
    agent = Agent(
        task=f"Go to ${feed.urls[0]} and extract the text content, author name, and any links from the first 15 posts. Return as JSON array.",
        llm_model="openai/gpt-4o-mini",  # browser-use needs an OpenAI-compatible model
    )
    result = await agent.run()
    print(json.dumps({"result": str(result)}))

asyncio.run(main())
`;
		const tmpPy = `/tmp/.8gent-feed-${feed.platform}-${Date.now()}.py`;
		fs.writeFileSync(tmpPy, pythonScript);

		const result = spawnSync("python3", [tmpPy], {
			encoding: "utf-8",
			timeout: 120000,
			env: { ...process.env },
		});

		try {
			fs.unlinkSync(tmpPy);
		} catch {}

		if (result.status !== 0) {
			log(`  browser-use failed: ${(result.stderr || "").slice(0, 200)}`);
			continue;
		}

		// Parse the result — browser-use returns unstructured text, so we score it directly
		const output = result.stdout.trim();
		const { score, keywords } = scoreRelevance(output);

		if (score >= 20) {
			findings.push({
				title: `[${feed.platform}] Feed finding`,
				source: feed.name,
				platform: feed.platform,
				author: "",
				url: feed.urls[0],
				summary: output.slice(0, 500),
				relevanceScore: score,
				matchedKeywords: keywords,
				targetRepo: classifyTarget(keywords),
				jtbd: "",
				pitch: "",
				effort: "medium",
				abstractable: true,
			});
		}
	}

	return findings;
}

// ============================================
// LLM analysis — generate JTBD pitch for each finding
// ============================================

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";

async function analyzeFinding(finding: Finding): Promise<Finding> {
	const prompt = `You are 8TO (Rishi), the Technology Officer for the 8GI Foundation.

Analyze this social media post for patterns we should adopt in our AI agent ecosystem.

POST:
"${finding.summary}"

Keywords matched: ${finding.matchedKeywords.join(", ")}
Target repo: ${finding.targetRepo}

Our ecosystem:
- 8gent-code: AI agent harness (brain/hands architecture, spawn protocol, skill compounding)
- 8gentjr: AAC communication app for children with speech difficulties
- 8gent-world: Marketing site and media decks
- 8gi-governance: Constitutional governance framework for AI agents

Respond in this EXACT JSON format:
{
  "jtbd": "When [user] needs to [job], they currently [pain point]. This pattern would let them [outcome].",
  "pitch": "Plain English explanation of why we need this. 2-3 sentences max.",
  "abstractable": true/false,
  "effort": "trivial|small|medium|large",
  "targetRepo": "8gent-code|8gentjr|8gent-world|8gi-governance",
  "title": "Short title for the GitHub issue (max 60 chars)"
}

If the post is NOT relevant to our ecosystem, set jtbd to "NOT_RELEVANT".`;

	try {
		let response: string;

		if (OPENROUTER_KEY) {
			// Use OpenRouter (vessel mode or local with key)
			const res = await fetch(OPENROUTER_URL, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${OPENROUTER_KEY}`,
				},
				body: JSON.stringify({
					model: "google/gemini-2.5-flash:free",
					messages: [{ role: "user", content: prompt }],
					max_tokens: 500,
				}),
				signal: AbortSignal.timeout(30000),
			});
			const data = (await res.json()) as any;
			response = data.choices?.[0]?.message?.content || "";
		} else {
			// Use local Ollama
			const res = await fetch(`${OLLAMA_URL}/api/chat`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "devstral:latest",
					messages: [{ role: "user", content: prompt }],
					stream: false,
					options: { num_predict: 500, temperature: 0.3 },
				}),
				signal: AbortSignal.timeout(60000),
			});
			const data = (await res.json()) as any;
			response = data.message?.content || "";
		}

		// Parse JSON from response
		const jsonMatch = response.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			const parsed = JSON.parse(jsonMatch[0]);
			if (parsed.jtbd === "NOT_RELEVANT") return finding;

			finding.jtbd = parsed.jtbd || finding.jtbd;
			finding.pitch = parsed.pitch || finding.pitch;
			finding.abstractable = parsed.abstractable ?? finding.abstractable;
			finding.effort = parsed.effort || finding.effort;
			finding.targetRepo = parsed.targetRepo || finding.targetRepo;
			if (parsed.title) finding.title = parsed.title;
		}
	} catch (err) {
		log(`  LLM analysis failed: ${err}`);
	}

	return finding;
}

// ============================================
// GitHub issue creation — quarantine proposals
// ============================================

async function createIssue(finding: Finding): Promise<string | null> {
	const body = `## Pattern Discovery — Social Feed Research

**Source:** ${finding.source} (${finding.platform})
**Author:** ${finding.author || "Unknown"}
**Relevance:** ${finding.relevanceScore}/100
**Keywords:** ${finding.matchedKeywords.join(", ")}

### JTBD (Job To Be Done)
${finding.jtbd}

### Why We Need This
${finding.pitch}

### Original Content
> ${finding.summary.slice(0, 300)}${finding.summary.length > 300 ? "..." : ""}

${finding.url !== finding.source ? `**Link:** ${finding.url}` : ""}

### Quarantine Assessment
- **Abstractable in <200 lines:** ${finding.abstractable ? "Yes" : "Needs investigation"}
- **Estimated effort:** ${finding.effort}
- **Target repo:** ${finding.targetRepo}

### Next Steps
1. Review this proposal during morning standup
2. If approved, create implementation spec
3. Follow quarantine pattern: branch -> implement -> security review -> PR

---
*Auto-discovered by 8gent Social Feed Research Pipeline*
*${new Date().toISOString()}*`;

	const label = "quarantine";
	const repo = `8gi-foundation/${finding.targetRepo}`;

	try {
		const result = spawnSync(
			"gh",
			[
				"issue",
				"create",
				"--repo",
				repo,
				"--title",
				`research: ${finding.title}`,
				"--body",
				body,
				"--label",
				label,
			],
			{ encoding: "utf-8", timeout: 15000 },
		);

		if (result.status === 0) {
			const url = result.stdout.trim();
			log(`  Created issue: ${url}`);
			return url;
		} else {
			// Label might not exist — try without label
			const retryResult = spawnSync(
				"gh",
				[
					"issue",
					"create",
					"--repo",
					repo,
					"--title",
					`research: ${finding.title}`,
					"--body",
					body,
				],
				{ encoding: "utf-8", timeout: 15000 },
			);

			if (retryResult.status === 0) {
				const url = retryResult.stdout.trim();
				log(`  Created issue (no label): ${url}`);
				return url;
			}

			log(
				`  Issue creation failed: ${(result.stderr || retryResult.stderr || "").slice(0, 200)}`,
			);
		}
	} catch (err) {
		log(`  Issue creation error: ${err}`);
	}

	return null;
}

// ============================================
// Telegram notification
// ============================================

async function notifyTelegram(
	findings: Finding[],
	issues: string[],
): Promise<void> {
	const token = TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
	if (!token) return;

	const text = [
		`*Social Feed Research Complete*`,
		"",
		`*Findings:* ${findings.length} relevant patterns`,
		`*Issues created:* ${issues.length}`,
		"",
		...findings
			.slice(0, 5)
			.map(
				(f, i) =>
					`${i + 1}. [${f.relevanceScore}] ${f.title.slice(0, 50)} → ${f.targetRepo}`,
			),
		findings.length > 5 ? `...and ${findings.length - 5} more` : "",
		"",
		`_Review in GitHub issues when you wake up._`,
	].join("\n");

	try {
		await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				chat_id: TELEGRAM_CHAT_ID,
				parse_mode: "Markdown",
				text,
			}),
		});
	} catch {}
}

// ============================================
// Dedup — don't create duplicate issues
// ============================================

function loadPreviousFindings(): Set<string> {
	const seen = new Set<string>();
	try {
		const files = fs
			.readdirSync(FINDINGS_DIR)
			.filter((f) => f.endsWith(".json"));
		for (const file of files) {
			const data = JSON.parse(
				fs.readFileSync(path.join(FINDINGS_DIR, file), "utf-8"),
			);
			if (data.url) seen.add(data.url);
			if (data.title) seen.add(data.title);
		}
	} catch {}
	return seen;
}

function saveFinding(finding: Finding): void {
	const id = `${finding.platform}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
	fs.writeFileSync(
		path.join(FINDINGS_DIR, `${id}.json`),
		JSON.stringify(finding, null, 2),
	);
}

// ============================================
// Main
// ============================================

export async function runSocialResearch(): Promise<{
	findings: Finding[];
	issues: string[];
}> {
	log("═══════════════════════════════════════════════════");
	log("Social Feed Research Pipeline — Starting");
	log(`Mode: ${isVessel ? "vessel (browser-use)" : "local (Playwright)"}`);
	log(`Dry run: ${isDryRun}`);
	log(`Max findings: ${maxFindings}`);
	log("═══════════════════════════════════════════════════");

	// Phase 1: Browse feeds
	let rawFindings: Finding[];
	if (isVessel) {
		rawFindings = await browseWithBrowserUse();
	} else {
		rawFindings = await browseWithPlaywright();
	}

	log(`Phase 1 complete: ${rawFindings.length} raw findings`);

	// Phase 2: Dedup against previous runs
	const seen = loadPreviousFindings();
	const newFindings = rawFindings.filter(
		(f) => !seen.has(f.url) && !seen.has(f.title),
	);
	log(`Phase 2: ${newFindings.length} new findings after dedup`);

	// Phase 3: Score and rank
	const ranked = newFindings
		.sort((a, b) => b.relevanceScore - a.relevanceScore)
		.slice(0, maxFindings);
	log(`Phase 3: Top ${ranked.length} findings by relevance`);

	// Phase 4: LLM analysis — generate JTBD pitch for each
	log("Phase 4: LLM analysis...");
	const analyzed: Finding[] = [];
	for (const finding of ranked) {
		const enriched = await analyzeFinding(finding);
		if (enriched.jtbd && enriched.jtbd !== "NOT_RELEVANT") {
			analyzed.push(enriched);
			saveFinding(enriched);
			log(
				`  [${enriched.relevanceScore}] ${enriched.title.slice(0, 50)} → ${enriched.targetRepo}`,
			);
		}
		// Rate limit
		await new Promise((r) => setTimeout(r, 2000));
	}

	log(`Phase 4 complete: ${analyzed.length} actionable findings`);

	// Phase 5: Create GitHub issues
	const issues: string[] = [];
	if (!isDryRun && analyzed.length > 0) {
		log("Phase 5: Creating GitHub issues...");
		for (const finding of analyzed) {
			const issueUrl = await createIssue(finding);
			if (issueUrl) issues.push(issueUrl);
			await new Promise((r) => setTimeout(r, 1000));
		}
		log(`Phase 5 complete: ${issues.length} issues created`);
	}

	// Notify
	await notifyTelegram(analyzed, issues);

	log("═══════════════════════════════════════════════════");
	log(`Social Feed Research Complete`);
	log(`  Findings: ${analyzed.length}`);
	log(`  Issues: ${issues.length}`);
	log("═══════════════════════════════════════════════════");

	return { findings: analyzed, issues };
}

// Run standalone
if (import.meta.main) {
	runSocialResearch().catch((err) => {
		log(`FATAL: ${err}`);
		process.exit(1);
	});
}
