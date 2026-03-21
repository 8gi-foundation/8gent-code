/**
 * 8gent Auto-Research Ability
 *
 * Autonomous research loop: query -> search -> fetch -> extract -> store -> repeat.
 * Inspired by: https://github.com/karpathy/autoresearch (Karpathy)
 *
 * Pattern: generate queries from topic, search web, fetch top pages, extract
 * key facts via local LLM, optionally loop for deeper coverage, synthesize report.
 */

import { webSearch } from "../tools/browser/web-search.js";
import { fetchPage } from "../tools/browser/fetch-page.js";
import type {
  ResearchOptions,
  ResearchReport,
  ResearchSource,
  ResearchPattern,
  ResearchIteration,
} from "./research-types.js";

// ── Constants ──────────────────────────────────────────────────────────

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const DEFAULT_MODEL = "llama3.2:latest";
const MAX_PAGE_CHARS = 2500;

// ── LLM Helper (minimal Ollama call, no SDK dep) ───────────────────────

async function ollamaGenerate(model: string, prompt: string): Promise<string> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false }),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}`);
    const data = await res.json() as { response?: string };
    return data.response?.trim() ?? "";
  } catch {
    // Fallback: skip synthesis if Ollama unavailable
    return "";
  }
}

// ── Query Generation ──────────────────────────────────────────────────

async function generateQueries(
  topic: string,
  focusAreas: string[],
  model: string,
  previousFindings: string[]
): Promise<string[]> {
  const focus = focusAreas.length ? `Focus areas: ${focusAreas.join(", ")}.` : "";
  const prior = previousFindings.length
    ? `\nAlready found: ${previousFindings.slice(0, 3).join("; ")}`
    : "";

  const prompt = `Generate 3 search queries to research: "${topic}". ${focus}${prior}
Return ONLY a JSON array of 3 strings, nothing else. Example: ["query 1", "query 2", "query 3"]`;

  const raw = await ollamaGenerate(model, prompt);

  // Parse JSON array from response
  const match = raw.match(/\[[\s\S]*?\]/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as unknown[];
      if (Array.isArray(parsed)) {
        return parsed.filter((q): q is string => typeof q === "string").slice(0, 3);
      }
    } catch { /* fall through */ }
  }

  // Fallback: derive queries without LLM
  const base = [topic];
  if (focusAreas.length) base.push(`${topic} ${focusAreas[0]}`);
  base.push(`${topic} best practices`);
  return base.slice(0, 3);
}

// ── Per-Page Extraction ────────────────────────────────────────────────

async function extractFindings(
  topic: string,
  pageText: string,
  model: string
): Promise<string[]> {
  const truncated = pageText.slice(0, MAX_PAGE_CHARS);
  const prompt = `From this text about "${topic}", extract 2-3 key facts or patterns as a JSON string array.
Return ONLY the JSON array. Text:
${truncated}`;

  const raw = await ollamaGenerate(model, prompt);
  const match = raw.match(/\[[\s\S]*?\]/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as unknown[];
      if (Array.isArray(parsed)) {
        return parsed.filter((f): f is string => typeof f === "string");
      }
    } catch { /* fall through */ }
  }
  // Fallback: use snippet directly
  return pageText.slice(0, 200) ? [pageText.slice(0, 200)] : [];
}

// ── One Research Iteration ─────────────────────────────────────────────

async function runIteration(
  topic: string,
  queries: string[],
  maxSources: number,
  model: string
): Promise<ResearchIteration> {
  const sources: ResearchSource[] = [];
  const rawFindings: string[] = [];
  const seenUrls = new Set<string>();

  for (const query of queries) {
    let results;
    try {
      results = await webSearch(query, Math.ceil(maxSources / queries.length));
    } catch {
      continue;
    }

    for (const result of results.slice(0, Math.ceil(maxSources / queries.length))) {
      if (seenUrls.has(result.url)) continue;
      seenUrls.add(result.url);

      // Relevance heuristic: keyword overlap
      const topicWords = topic.toLowerCase().split(/\s+/);
      const combined = `${result.title} ${result.snippet}`.toLowerCase();
      const hits = topicWords.filter(w => combined.includes(w)).length;
      const relevance = Math.min(1, hits / Math.max(topicWords.length, 1));

      const source: ResearchSource = {
        url: result.url,
        title: result.title,
        snippet: result.snippet,
        relevance,
      };

      // Fetch top-relevance pages for deep extraction
      if (relevance >= 0.3 && sources.length < maxSources) {
        try {
          const page = await fetchPage(result.url);
          source.extractedText = page.text.slice(0, MAX_PAGE_CHARS);
          const findings = await extractFindings(topic, page.text, model);
          rawFindings.push(...findings);
        } catch {
          // Page fetch failed; keep snippet-only source
        }
      }

      sources.push(source);
    }
  }

  return { queries, sources, rawFindings };
}

// ── Final Synthesis ────────────────────────────────────────────────────

async function synthesize(
  topic: string,
  allFindings: string[],
  sources: ResearchSource[],
  model: string
): Promise<{
  keyFindings: string[];
  patterns: ResearchPattern[];
  recommendations: string[];
  furtherQuestions: string[];
}> {
  const findingsText = allFindings.slice(0, 20).join("\n- ");
  const prompt = `Synthesize research on "${topic}". Findings:\n- ${findingsText}

Return a JSON object with these exact keys:
{
  "keyFindings": ["string"],
  "patterns": [{"name": "string", "description": "string"}],
  "recommendations": ["string"],
  "furtherQuestions": ["string"]
}`;

  const raw = await ollamaGenerate(model, prompt);
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as {
        keyFindings?: unknown;
        patterns?: unknown;
        recommendations?: unknown;
        furtherQuestions?: unknown;
      };
      const arr = (v: unknown): string[] =>
        Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
      const pats = Array.isArray(parsed.patterns)
        ? (parsed.patterns as Array<Record<string, string>>)
            .filter(p => p && typeof p.name === "string")
            .map(p => ({ name: p.name, description: p.description ?? "" }))
        : [];
      return {
        keyFindings: arr(parsed.keyFindings),
        patterns: pats,
        recommendations: arr(parsed.recommendations),
        furtherQuestions: arr(parsed.furtherQuestions),
      };
    } catch { /* fall through */ }
  }

  // Fallback: surface raw findings as key findings
  return {
    keyFindings: allFindings.slice(0, 5),
    patterns: [],
    recommendations: [],
    furtherQuestions: [],
  };
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Research a topic autonomously.
 *
 * Runs a configurable search-fetch-extract loop then synthesizes a report.
 * Stores key findings in the memory system when available.
 */
export async function research(
  topic: string,
  opts: ResearchOptions = {}
): Promise<ResearchReport> {
  const depth = Math.max(1, Math.min(5, opts.depth ?? 2));
  const maxSources = opts.maxSources ?? 10;
  const focusAreas = opts.focusAreas ?? [];
  const model = opts.model ?? DEFAULT_MODEL;

  const startAt = Date.now();
  const allSources: ResearchSource[] = [];
  const allFindings: string[] = [];
  const allQueries: string[] = [];

  // Each depth level = one iteration with refined queries
  for (let d = 0; d < depth; d++) {
    const queries = await generateQueries(topic, focusAreas, model, allFindings);
    allQueries.push(...queries);

    const iter = await runIteration(topic, queries, maxSources, model);
    allSources.push(...iter.sources);
    allFindings.push(...iter.rawFindings);
  }

  // Deduplicate sources by URL
  const seen = new Set<string>();
  const uniqueSources = allSources.filter(s => {
    if (seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  }).sort((a, b) => b.relevance - a.relevance).slice(0, maxSources);

  const synthesis = await synthesize(topic, allFindings, uniqueSources, model);

  // Persist to memory if available (best-effort)
  try {
    const { MemoryStore } = await import("../memory/store.js");
    const { generateId } = await import("../memory/types.js");
    const os = await import("os");
    const path = await import("path");
    const dbPath = path.join(os.homedir(), ".8gent", "memory.db");
    const store = new MemoryStore(dbPath);
    const now = Date.now();
    store.write({
      id: generateId("mem"),
      type: "semantic",
      category: "fact",
      key: `research:${topic.toLowerCase().replace(/\s+/g, "-")}`,
      value: `Research on "${topic}": ${synthesis.keyFindings.slice(0, 2).join("; ")}`,
      scope: "project",
      importance: 0.7,
      decayFactor: 1.0,
      accessCount: 0,
      lastAccessed: now,
      confidence: 0.8,
      evidenceCount: uniqueSources.length,
      tags: ["research", "autoresearch", ...focusAreas],
      relatedKeys: [],
      learnedAt: now,
      lastConfirmed: now,
      source: "extraction",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    store.close();
  } catch { /* memory not available in all contexts */ }

  return {
    topic,
    sources: uniqueSources,
    keyFindings: synthesis.keyFindings,
    patterns: synthesis.patterns,
    recommendations: synthesis.recommendations,
    furtherQuestions: synthesis.furtherQuestions,
    searchQueries: allQueries.filter((q, i, arr) => arr.indexOf(q) === i),
    duration: Date.now() - startAt,
  };
}
