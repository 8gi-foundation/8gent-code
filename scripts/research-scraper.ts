/**
 * research-scraper.ts
 * Nightly scraper that feeds the utility factory queue from real sources.
 * Sources: npm trending, GitHub trending (TS), GitHub trending (all), Hacker News
 *
 * Usage:
 *   bun run scripts/research-scraper.ts          -- run once
 *   bun run scripts/research-scraper.ts --loop   -- run every 4 hours
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..");
const QUEUE_PATH = join(SCRIPT_DIR, "utility-queue.json");
const LOG_PATH = join(SCRIPT_DIR, "research-log.json");
const TOOLS_DIR = join(REPO_ROOT, "packages", "tools");
const ENV_PATH = join(process.env.HOME ?? "", ".claude", ".env");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UtilitySpec {
  name: string;
  description: string;
  requirements: string[];
  maxLines: number;
  source?: string;
}

interface LogEntry {
  timestamp: string;
  sources: string[];
  found: number;
  added: number;
  skipped: number;
  newSpecs: string[];
}

// ---------------------------------------------------------------------------
// Env loader (no dotenv dep - manual parse)
// ---------------------------------------------------------------------------

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  if (!existsSync(ENV_PATH)) return env;
  const lines = readFileSync(ENV_PATH, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    env[key] = val;
  }
  return env;
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

async function sendTelegram(token: string, chatId: string, text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
  } catch (e) {
    console.warn("Telegram send failed:", e);
  }
}

// ---------------------------------------------------------------------------
// HTML helpers (no DOM parser - pure regex/string)
// ---------------------------------------------------------------------------

function extractBetween(html: string, open: string, close: string): string[] {
  const results: string[] = [];
  let cursor = 0;
  while (true) {
    const start = html.indexOf(open, cursor);
    if (start < 0) break;
    const contentStart = start + open.length;
    const end = html.indexOf(close, contentStart);
    if (end < 0) break;
    results.push(html.slice(contentStart, end).trim());
    cursor = end + close.length;
  }
  return results;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function clean(s: string): string {
  return decodeEntities(stripTags(s)).trim();
}

// ---------------------------------------------------------------------------
// Dedup utilities
// ---------------------------------------------------------------------------

function loadExistingNames(): Set<string> {
  const names = new Set<string>();

  // From queue
  if (existsSync(QUEUE_PATH)) {
    try {
      const queue: UtilitySpec[] = JSON.parse(readFileSync(QUEUE_PATH, "utf8"));
      for (const spec of queue) names.add(spec.name.toLowerCase());
    } catch {}
  }

  // From packages/tools/*.ts filenames
  try {
    const files = readdirSync(TOOLS_DIR).filter((f) => f.endsWith(".ts"));
    for (const f of files) names.add(f.replace(/\.ts$/, "").toLowerCase());
  } catch {}

  return names;
}

function loadExistingDescriptions(): string[] {
  if (!existsSync(QUEUE_PATH)) return [];
  try {
    const queue: UtilitySpec[] = JSON.parse(readFileSync(QUEUE_PATH, "utf8"));
    return queue.map((s) => s.description.toLowerCase());
  } catch {
    return [];
  }
}

function wordOverlap(a: string, b: string): number {
  const wordsA = new Set(a.split(/\W+/).filter((w) => w.length > 3));
  let matches = 0;
  for (const w of b.split(/\W+/)) {
    if (w.length > 3 && wordsA.has(w)) matches++;
  }
  const maxLen = Math.max(wordsA.size, 1);
  return matches / maxLen;
}

function isTooSimilar(desc: string, existing: string[]): boolean {
  const lower = desc.toLowerCase();
  for (const ex of existing) {
    if (wordOverlap(lower, ex) > 0.6) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Slug helper
// ---------------------------------------------------------------------------

function toKebab(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// ---------------------------------------------------------------------------
// Source 1: npm
// ---------------------------------------------------------------------------

async function scrapeNpm(): Promise<UtilitySpec[]> {
  console.log("  Fetching npm...");
  let html = "";
  try {
    const res = await fetch("https://www.npmjs.com/", {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; 8gent-research-scraper/1.0)" },
      signal: AbortSignal.timeout(15000),
    });
    html = await res.text();
  } catch (e) {
    console.warn("  npm fetch failed:", e);
    return [];
  }

  const specs: UtilitySpec[] = [];

  // npm renders package cards - extract anchor text blocks with package names
  // Pattern: href="/package/<name>" ... description text
  const pkgRegex = /href="\/package\/([a-z0-9@/_-]+)"[^>]*>([^<]*)</gi;
  const found = new Map<string, string>();

  let m: RegExpExecArray | null;
  while ((m = pkgRegex.exec(html)) !== null) {
    const name = m[1].replace(/^@[^/]+\//, ""); // strip scope for kebab
    const text = clean(m[2]);
    if (name.length > 2 && text.length > 5 && !found.has(name)) {
      found.set(name, text);
    }
  }

  // Also try description spans near package links
  const sections = html.split(/href="\/package\//);
  for (let i = 1; i < Math.min(sections.length, 30); i++) {
    const sec = sections[i];
    const nameEnd = sec.indexOf('"');
    if (nameEnd < 0) continue;
    const rawName = sec.slice(0, nameEnd);
    const slug = toKebab(rawName.replace(/^@[^/]+\//, ""));
    if (slug.length < 2) continue;

    // Grab nearby text for description
    const textChunk = clean(sec.slice(nameEnd, Math.min(nameEnd + 400, sec.length)));
    const descMatch = textChunk.match(/([A-Z][^.!?]{15,120}[.!?])/);
    const desc = descMatch ? descMatch[1].trim() : textChunk.slice(0, 80).trim();

    if (desc.length > 15 && !found.has(slug)) {
      found.set(slug, desc);
    }
  }

  for (const [name, desc] of found) {
    if (specs.length >= 15) break;
    specs.push({
      name: toKebab(name),
      description: desc,
      requirements: [
        "Zero external dependencies",
        "TypeScript-first with exported types",
        "Minimal API surface - only what is necessary",
      ],
      maxLines: 150,
      source: "npm",
    });
  }

  return specs;
}

// ---------------------------------------------------------------------------
// Source 2 & 3: GitHub trending
// ---------------------------------------------------------------------------

async function scrapeGithubTrending(url: string, sourceLabel: string): Promise<UtilitySpec[]> {
  console.log(`  Fetching ${sourceLabel}...`);
  let html = "";
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; 8gent-research-scraper/1.0)" },
      signal: AbortSignal.timeout(15000),
    });
    html = await res.text();
  } catch (e) {
    console.warn(`  ${sourceLabel} fetch failed:`, e);
    return [];
  }

  const specs: UtilitySpec[] = [];

  // GitHub trending: repo names in h2 > a, descriptions in p.col-9
  // Pattern: <h2 class="h3 lh-condensed"> ... <a href="/owner/repo">
  const repoBlocks = html.split('<article class="Box-row');
  for (let i = 1; i < Math.min(repoBlocks.length, 20); i++) {
    const block = repoBlocks[i];

    // Extract repo name from href
    const hrefMatch = block.match(/href="\/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)"/);
    if (!hrefMatch) continue;
    const fullName = hrefMatch[1];
    const repoName = fullName.split("/")[1];
    const slug = toKebab(repoName);

    // Extract description - look for p tag content
    const descMatch = block.match(/<p[^>]*class="[^"]*col-9[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    const rawDesc = descMatch ? clean(descMatch[1]) : "";

    // Also try itemprop="description"
    const itemPropMatch = block.match(/itemprop="description"[^>]*>([\s\S]*?)</);
    const desc = (rawDesc.length > 10 ? rawDesc : itemPropMatch ? clean(itemPropMatch[1]) : "").slice(0, 140);

    if (slug.length < 2 || desc.length < 10) continue;

    specs.push({
      name: slug,
      description: desc,
      requirements: [
        "Implement the core pattern as a self-contained TypeScript module",
        "Export a clean functional API",
        "Under 200 lines, zero dependencies",
      ],
      maxLines: 200,
      source: sourceLabel,
    });
  }

  return specs;
}

// ---------------------------------------------------------------------------
// Source 4: Hacker News
// ---------------------------------------------------------------------------

async function scrapeHackerNews(): Promise<UtilitySpec[]> {
  console.log("  Fetching Hacker News...");
  let html = "";
  try {
    const res = await fetch("https://news.ycombinator.com/", {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; 8gent-research-scraper/1.0)" },
      signal: AbortSignal.timeout(15000),
    });
    html = await res.text();
  } catch (e) {
    console.warn("  HN fetch failed:", e);
    return [];
  }

  const specs: UtilitySpec[] = [];

  // HN structure: <span class="titleline"><a href="...">TITLE</a>
  const titleRegex = /<span class="titleline"><a href="([^"]+)"[^>]*>([^<]+)<\/a>/g;
  let m: RegExpExecArray | null;

  const devKeywords = [
    "library", "tool", "cli", "framework", "parser", "compiler", "runtime",
    "sdk", "api", "npm", "typescript", "javascript", "rust", "go",
    "open source", "utility", "package", "module", "plugin",
  ];

  while ((m = titleRegex.exec(html)) !== null) {
    const href = m[1];
    const title = clean(m[2]);
    if (title.length < 5) continue;

    const lower = title.toLowerCase();
    const isDev = devKeywords.some((kw) => lower.includes(kw));
    if (!isDev) continue;

    // Derive a utility slug from the title
    const words = title.split(/\W+/).filter((w) => w.length > 2).slice(0, 4);
    const slug = toKebab(words.join("-"));
    if (slug.length < 3) continue;

    specs.push({
      name: slug,
      description: title,
      requirements: [
        "Implement the core idea as a TypeScript utility",
        "Zero external dependencies",
        "Minimal API - one clear export",
      ],
      maxLines: 150,
      source: "hn",
    });

    if (specs.length >= 15) break;
  }

  return specs;
}

// ---------------------------------------------------------------------------
// Feynman-extracted specs (hardcoded, always appended if not already present)
// ---------------------------------------------------------------------------

const FEYNMAN_SPECS: UtilitySpec[] = [
  {
    name: "research-pipeline",
    description:
      "4-stage adversarial research pipeline - researcher finds sources, writer drafts, verifier checks URLs, reviewer audits adversarially",
    requirements: [
      "Export createResearchPipeline(topic) returning a pipeline orchestrator",
      "4 stages: research (gather sources with URLs), write (draft from sources only), verify (fetch every URL, remove unverifiable claims), review (adversarial audit with FATAL/MAJOR/MINOR severity)",
      "File-based intermediate state - each stage writes to disk, next stage reads files not inline content",
      "Provenance tracking - record sources consulted, accepted, rejected per stage",
    ],
    maxLines: 200,
    source: "feynman",
  },
  {
    name: "research-provenance",
    description:
      "Provenance sidecar generator - tracks sources consulted, accepted, rejected, and verification status for any research artifact",
    requirements: [
      "Export createProvenance(slug) returning a provenance tracker",
      "Methods: addSource(url, status), addClaim(text, sourceUrl, verified), toMarkdown()",
      "Track rounds of research, total sources found vs accepted vs rejected",
      "Generate <slug>.provenance.md sidecar file alongside the research output",
    ],
    maxLines: 100,
    source: "feynman",
  },
  {
    name: "research-integrity",
    description:
      "Research integrity validator - enforces URL-or-it-didnt-happen rules on any text claiming facts or citing sources",
    requirements: [
      "Export validateIntegrity(text) returning { valid: boolean, issues: IntegrityIssue[] }",
      "Detect claims without URLs, fabricated-looking URLs, dead URL patterns, summary-without-source patterns",
      "Severity levels: FATAL (fabricated source), MAJOR (claim without citation), MINOR (incomplete reference)",
      "Export integrityRules as typed constants for use in agent system prompts",
    ],
    maxLines: 120,
    source: "feynman",
  },
];

// ---------------------------------------------------------------------------
// Main run
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const env = loadEnv();
  const telegramToken = env["TELEGRAM_BOT_TOKEN"] ?? "";
  const telegramChat = env["TELEGRAM_CHAT_ID"] ?? "5486040131";

  console.log("Research scraper starting...");

  // Load existing state
  const existingNames = loadExistingNames();
  const existingDescs = loadExistingDescriptions();

  // Collect from all sources
  const [npmSpecs, ghTsSpecs, ghAllSpecs, hnSpecs] = await Promise.all([
    scrapeNpm(),
    scrapeGithubTrending("https://github.com/trending/typescript?since=daily", "github-ts"),
    scrapeGithubTrending("https://github.com/trending?since=daily", "github-all"),
    scrapeHackerNews(),
  ]);

  const allScraped = [...npmSpecs, ...ghTsSpecs, ...ghAllSpecs, ...hnSpecs];
  console.log(`\nScraped ${allScraped.length} candidates across 4 sources`);

  // Deduplicate and filter
  const newSpecs: UtilitySpec[] = [];
  const skippedNames: string[] = [];
  const sessionNames = new Set<string>();

  const filterAndAdd = (spec: UtilitySpec) => {
    const nameKey = spec.name.toLowerCase();
    if (existingNames.has(nameKey) || sessionNames.has(nameKey)) {
      skippedNames.push(spec.name);
      return;
    }
    if (isTooSimilar(spec.description, existingDescs)) {
      skippedNames.push(spec.name + " (similar desc)");
      return;
    }
    // Security: never execute - only text descriptions pass through
    if (spec.description.length > 200) {
      spec.description = spec.description.slice(0, 200);
    }
    newSpecs.push(spec);
    sessionNames.add(nameKey);
    existingDescs.push(spec.description.toLowerCase());
  };

  for (const spec of allScraped) filterAndAdd(spec);

  // Feynman specs
  for (const spec of FEYNMAN_SPECS) filterAndAdd(spec);

  console.log(`\nNew specs: ${newSpecs.length} | Skipped: ${skippedNames.length}`);

  // Append to queue
  let currentQueue: UtilitySpec[] = [];
  if (existsSync(QUEUE_PATH)) {
    try {
      currentQueue = JSON.parse(readFileSync(QUEUE_PATH, "utf8"));
    } catch {}
  }
  const updatedQueue = [...currentQueue, ...newSpecs];
  writeFileSync(QUEUE_PATH, JSON.stringify(updatedQueue, null, 2));
  console.log(`Queue updated: ${currentQueue.length} -> ${updatedQueue.length} entries`);

  // Append to log
  let log: LogEntry[] = [];
  if (existsSync(LOG_PATH)) {
    try {
      log = JSON.parse(readFileSync(LOG_PATH, "utf8"));
    } catch {}
  }
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    sources: ["npm", "github-ts", "github-all", "hn"],
    found: allScraped.length,
    added: newSpecs.length,
    skipped: skippedNames.length,
    newSpecs: newSpecs.map((s) => s.name),
  };
  log.push(entry);
  writeFileSync(LOG_PATH, JSON.stringify(log, null, 2));
  console.log(`Log updated: ${log.length} total runs`);

  // Telegram summary
  if (telegramToken) {
    const sourceBreakdown = [
      `npm: ${npmSpecs.length}`,
      `github-ts: ${ghTsSpecs.length}`,
      `github-all: ${ghAllSpecs.length}`,
      `hn: ${hnSpecs.length}`,
    ].join(", ");
    const msg =
      `Research scraper found <b>${newSpecs.length} new abilities</b> from 4 sources\n` +
      `Sources: ${sourceBreakdown}\n` +
      `Queue total: ${updatedQueue.length} specs\n` +
      (newSpecs.length > 0
        ? `Added: ${newSpecs.slice(0, 8).map((s) => s.name).join(", ")}${newSpecs.length > 8 ? ` +${newSpecs.length - 8} more` : ""}`
        : "No new specs this run (all deduplicated)");
    await sendTelegram(telegramToken, telegramChat, msg);
    console.log("Telegram sent.");
  } else {
    console.warn("No TELEGRAM_BOT_TOKEN found - skipping Telegram.");
  }

  console.log("\nDone.");
}

// ---------------------------------------------------------------------------
// Loop mode
// ---------------------------------------------------------------------------

const CYCLE_MS = 30 * 60 * 1000; // 30 minutes

async function loopForever(): Promise<void> {
  while (true) {
    await run();
    console.log(`\nSleeping 30 minutes until next cycle...`);
    await new Promise((res) => setTimeout(res, CYCLE_MS));
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

if (process.argv.includes("--loop")) {
  loopForever().catch(console.error);
} else {
  run().catch(console.error);
}
