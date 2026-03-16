/**
 * 8gent Code - Multi-Layered Memory System
 *
 * Three-tier knowledge persistence:
 *   1. Session  — ephemeral, lives in-process for the current conversation
 *   2. Project  — persisted per working directory at .8gent/memory/project.jsonl
 *   3. Global   — persisted per user at ~/.8gent/memory/global.jsonl
 *
 * Each memory entry is a timestamped fact with a unique ID.
 * Recall uses simple keyword matching (upgradeable to embeddings later).
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

// ============================================
// Types
// ============================================

export type MemoryLayer = "session" | "project" | "global";

export interface MemoryEntry {
  id: string;
  fact: string;
  layer: MemoryLayer;
  tags: string[];
  createdAt: string;
  source?: string; // e.g. "auto:read_file", "user:remember", "auto:run_command"
}

export interface RecallResult {
  entry: MemoryEntry;
  score: number; // 0-1 relevance score
}

// ============================================
// Persistence helpers
// ============================================

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function appendJsonl(filePath: string, entry: MemoryEntry): void {
  ensureDir(filePath);
  fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");
}

function readJsonl(filePath: string): MemoryEntry[] {
  if (!fs.existsSync(filePath)) return [];

  const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
  const entries: MemoryEntry[] = [];

  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as MemoryEntry);
    } catch {
      // Skip corrupted lines — best-effort persistence
    }
  }

  return entries;
}

function writeJsonl(filePath: string, entries: MemoryEntry[]): void {
  ensureDir(filePath);
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length > 0 ? "\n" : "");
  fs.writeFileSync(filePath, content, "utf-8");
}

// ============================================
// Keyword scoring
// ============================================

/**
 * Simple keyword-based relevance scoring.
 * Splits the query into tokens and scores each entry by the fraction of
 * query tokens that appear in the fact text (case-insensitive).
 * Recency gives a small boost (newer entries score slightly higher).
 */
function scoreEntry(entry: MemoryEntry, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;

  const factLower = entry.fact.toLowerCase();
  const tagText = entry.tags.join(" ").toLowerCase();
  const searchable = factLower + " " + tagText;

  let matches = 0;
  for (const token of queryTokens) {
    if (searchable.includes(token)) matches++;
  }

  const keywordScore = matches / queryTokens.length;

  // Recency boost: entries from the last hour get up to +0.1
  const ageMs = Date.now() - new Date(entry.createdAt).getTime();
  const recencyBoost = Math.max(0, 0.1 * (1 - ageMs / (60 * 60 * 1000)));

  return Math.min(1, keywordScore + recencyBoost);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

// ============================================
// MemoryManager
// ============================================

export class MemoryManager {
  private sessionMemories: MemoryEntry[] = [];
  private projectPath: string;
  private globalPath: string;

  constructor(workingDirectory: string) {
    this.projectPath = path.join(workingDirectory, ".8gent", "memory", "project.jsonl");
    this.globalPath = path.join(os.homedir(), ".8gent", "memory", "global.jsonl");
  }

  // ── Store ──────────────────────────────────────────────────────────

  /**
   * Store a fact in the specified memory layer.
   * Returns the generated memory ID.
   */
  remember(fact: string, layer: MemoryLayer, options?: { tags?: string[]; source?: string }): string {
    const id = `mem_${crypto.randomBytes(6).toString("hex")}`;

    const entry: MemoryEntry = {
      id,
      fact,
      layer,
      tags: options?.tags ?? extractTags(fact),
      createdAt: new Date().toISOString(),
      source: options?.source,
    };

    switch (layer) {
      case "session":
        this.sessionMemories.push(entry);
        break;
      case "project":
        appendJsonl(this.projectPath, entry);
        break;
      case "global":
        appendJsonl(this.globalPath, entry);
        break;
    }

    return id;
  }

  // ── Recall ─────────────────────────────────────────────────────────

  /**
   * Search across all memory layers for entries matching the query.
   * Returns results sorted by relevance score (descending).
   */
  recall(query: string, limit: number = 10): RecallResult[] {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const allEntries = [
      ...this.sessionMemories,
      ...readJsonl(this.projectPath),
      ...readJsonl(this.globalPath),
    ];

    // Deduplicate by ID (session might shadow persisted entries)
    const seen = new Set<string>();
    const unique: MemoryEntry[] = [];
    for (const entry of allEntries) {
      if (!seen.has(entry.id)) {
        seen.add(entry.id);
        unique.push(entry);
      }
    }

    const scored: RecallResult[] = unique
      .map((entry) => ({ entry, score: scoreEntry(entry, queryTokens) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return scored;
  }

  // ── Forget ─────────────────────────────────────────────────────────

  /**
   * Remove a memory entry by ID from any layer.
   * Returns true if the entry was found and removed.
   */
  forget(factId: string): boolean {
    // Check session
    const sessionIdx = this.sessionMemories.findIndex((e) => e.id === factId);
    if (sessionIdx !== -1) {
      this.sessionMemories.splice(sessionIdx, 1);
      return true;
    }

    // Check project
    if (this.removeFromJsonl(this.projectPath, factId)) return true;

    // Check global
    if (this.removeFromJsonl(this.globalPath, factId)) return true;

    return false;
  }

  private removeFromJsonl(filePath: string, factId: string): boolean {
    const entries = readJsonl(filePath);
    const filtered = entries.filter((e) => e.id !== factId);
    if (filtered.length < entries.length) {
      writeJsonl(filePath, filtered);
      return true;
    }
    return false;
  }

  // ── Context ────────────────────────────────────────────────────────

  /**
   * Build a compressed context string from all memory layers
   * suitable for injection into system/user prompts.
   *
   * Prioritizes project and global memories over session (which the
   * model already has access to via conversation history).
   */
  getContext(maxTokens: number = 2000): string {
    const projectEntries = readJsonl(this.projectPath);
    const globalEntries = readJsonl(this.globalPath);

    // Approximate 4 chars per token
    const charBudget = maxTokens * 4;

    const sections: string[] = [];
    let used = 0;

    // Project memories first (most relevant to current work)
    if (projectEntries.length > 0) {
      sections.push("[Project Memory]");
      used += 20;

      // Most recent first
      const sorted = [...projectEntries].reverse();
      for (const entry of sorted) {
        const line = `- ${entry.fact}`;
        if (used + line.length > charBudget) break;
        sections.push(line);
        used += line.length;
      }
    }

    // Global memories
    if (globalEntries.length > 0 && used < charBudget * 0.9) {
      sections.push("\n[Global Memory]");
      used += 20;

      const sorted = [...globalEntries].reverse();
      for (const entry of sorted) {
        const line = `- ${entry.fact}`;
        if (used + line.length > charBudget) break;
        sections.push(line);
        used += line.length;
      }
    }

    // Session memories (brief, since the model already sees the conversation)
    if (this.sessionMemories.length > 0 && used < charBudget * 0.9) {
      sections.push("\n[Session Memory]");
      used += 20;

      for (const entry of [...this.sessionMemories].reverse()) {
        const line = `- ${entry.fact}`;
        if (used + line.length > charBudget) break;
        sections.push(line);
        used += line.length;
      }
    }

    if (sections.length === 0) return "";

    return sections.join("\n");
  }

  // ── Accessors ──────────────────────────────────────────────────────

  getSessionMemories(): MemoryEntry[] {
    return [...this.sessionMemories];
  }

  getProjectMemories(): MemoryEntry[] {
    return readJsonl(this.projectPath);
  }

  getGlobalMemories(): MemoryEntry[] {
    return readJsonl(this.globalPath);
  }

  getStats(): { session: number; project: number; global: number } {
    return {
      session: this.sessionMemories.length,
      project: readJsonl(this.projectPath).length,
      global: readJsonl(this.globalPath).length,
    };
  }
}

// ============================================
// Auto-tag extraction
// ============================================

/**
 * Extract simple tags from a fact string.
 * Pulls out file extensions, config file names, and tech-stack keywords.
 */
function extractTags(fact: string): string[] {
  const tags: string[] = [];

  // File extensions
  const extMatches = fact.match(/\.\w{1,6}\b/g);
  if (extMatches) {
    for (const ext of extMatches) {
      if ([".ts", ".tsx", ".js", ".jsx", ".json", ".yaml", ".toml", ".css", ".html", ".py", ".go", ".rs"].includes(ext)) {
        tags.push(ext.slice(1)); // remove dot
      }
    }
  }

  // Config files
  const configPatterns = ["package.json", "tsconfig", "eslint", "prettier", "vite", "webpack", "next.config", "tailwind"];
  for (const pat of configPatterns) {
    if (fact.toLowerCase().includes(pat)) tags.push("config");
  }

  // Tech stack keywords
  const techKeywords = ["react", "vue", "svelte", "next", "bun", "node", "deno", "typescript", "python", "rust", "go", "docker", "kubernetes", "postgres", "redis", "mongodb", "supabase", "prisma", "drizzle"];
  const factLower = fact.toLowerCase();
  for (const kw of techKeywords) {
    if (factLower.includes(kw)) tags.push(kw);
  }

  return [...new Set(tags)];
}

// ============================================
// Auto-memory helpers for agent integration
// ============================================

/**
 * Analyze a tool call result and extract facts worth remembering.
 * Called from agent.ts onToolCallFinish to auto-populate project memory.
 */
export function extractAutoMemories(
  toolName: string,
  args: Record<string, unknown>,
  result: string
): { fact: string; layer: MemoryLayer }[] {
  const facts: { fact: string; layer: MemoryLayer }[] = [];

  // When reading package.json — extract project info
  if (toolName === "read_file" && String(args.path || "").endsWith("package.json")) {
    try {
      const pkg = JSON.parse(result);
      if (pkg.name) facts.push({ fact: `Project name: ${pkg.name}`, layer: "project" });
      if (pkg.description) facts.push({ fact: `Project description: ${pkg.description}`, layer: "project" });

      // Extract key dependencies as tech stack
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const significant = Object.keys(deps).filter((d) =>
        ["react", "vue", "svelte", "next", "nuxt", "express", "fastify", "hono", "bun", "typescript", "tailwindcss", "prisma", "drizzle", "supabase"].includes(d)
      );
      if (significant.length > 0) {
        facts.push({ fact: `Tech stack includes: ${significant.join(", ")}`, layer: "project" });
      }
    } catch {
      // Not valid JSON, skip
    }
  }

  // When reading tsconfig — note TypeScript config
  if (toolName === "read_file" && String(args.path || "").includes("tsconfig")) {
    facts.push({ fact: `Project uses TypeScript (found ${args.path})`, layer: "project" });
  }

  // When discovering a Dockerfile or docker-compose
  if (toolName === "read_file" && /dockerfile|docker-compose/i.test(String(args.path || ""))) {
    facts.push({ fact: `Project uses Docker (found ${args.path})`, layer: "project" });
  }

  // When running commands that reveal env info
  if (toolName === "run_command") {
    const cmd = String(args.command || "");

    // Detect runtime info
    if (cmd.includes("node --version") || cmd.includes("bun --version")) {
      facts.push({ fact: `Runtime version: ${result.trim()}`, layer: "project" });
    }

    // Detect test framework from test commands
    if (cmd.includes("test") && result.includes("pass")) {
      facts.push({ fact: `Tests are passing (ran: ${cmd.slice(0, 60)})`, layer: "session" });
    }
  }

  // When the agent reads a README — extract purpose
  if (toolName === "read_file" && /readme/i.test(String(args.path || ""))) {
    // Extract first meaningful line as project purpose
    const lines = result.split("\n").filter((l) => l.trim() && !l.startsWith("#") && l.length > 20);
    if (lines.length > 0) {
      facts.push({ fact: `Project purpose: ${lines[0].trim().slice(0, 200)}`, layer: "project" });
    }
  }

  return facts;
}

// ============================================
// Singleton accessor
// ============================================

let _instance: MemoryManager | null = null;

export function getMemoryManager(workingDirectory?: string): MemoryManager {
  if (!_instance && workingDirectory) {
    _instance = new MemoryManager(workingDirectory);
  }
  if (!_instance) {
    _instance = new MemoryManager(process.cwd());
  }
  return _instance;
}

/**
 * Reset the singleton (for testing).
 */
export function resetMemoryManager(): void {
  _instance = null;
}
