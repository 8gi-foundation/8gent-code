/**
 * Memory v2 — Multi-Layered Knowledge Intelligence
 *
 * MemoryManager v2 facade providing:
 *   - remember(content, type, metadata) — auto-embeds, stores in SQLite
 *   - recall(query, options)            — hybrid FTS5 + vector search
 *   - forget(id)                        — soft delete with version history
 *   - getContext(tokenBudget)           — context window assembly for prompt injection
 *
 * Storage: SQLite with WAL mode, FTS5 full-text search, optional nomic-embed-text embeddings.
 * Backwards-compatible with v1 API (MemoryManager class with same method signatures).
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  type Memory,
  type MemoryType,
  type MemoryScope,
  type SourceType,
  type SemanticCategory,
  type CoreCategory,
  type SearchOptions,
  type SearchResult,
  type ContextWindowOptions,
  type ContextWindow,
  type ContextEntry,
  type CoreMemory,
  type EpisodicMemory,
  type SemanticMemory,
  type ProceduralMemory,
  type ProceduralStep,
  type WorkingMemory,
  type V1MemoryEntry,
  type V1RecallResult,
  generateId,
  estimateTokens,
  effectiveImportance,
} from "./types.js";
import { MemoryStore } from "./store.js";
import {
  getEmbeddingProvider,
  type EmbeddingProvider,
  OllamaEmbeddingProvider,
  NullEmbeddingProvider,
} from "./embeddings.js";
import { migrateV1ToV2, type MigrationResult } from "./migrate.js";
import { KnowledgeGraph, type Entity, type Relationship, type SubgraphResult } from "./graph.js";
import { extractFromToolResult, extractPreferencesFromMessage, type ExtractionResult, type ExtractedEntity, type ExtractedRelationship } from "./extractor.js";
import { PromotionManager, isPromoted, daysUntilArchival, type PromotionResult } from "./promote.js";
import { SemanticRecall, createSemanticRecall, type RecallOptions } from "./recall.js";

// ── Re-exports ────────────────────────────────────────────────────────

export type {
  Memory,
  MemoryType,
  MemoryScope,
  SourceType,
  SemanticCategory,
  CoreCategory,
  SearchOptions,
  SearchResult,
  ContextWindowOptions,
  ContextWindow,
  ContextEntry,
  CoreMemory,
  EpisodicMemory,
  SemanticMemory,
  ProceduralMemory,
  ProceduralStep,
  WorkingMemory,
  V1MemoryEntry,
  V1RecallResult,
  MigrationResult,
  EmbeddingProvider,
};

export {
  generateId,
  estimateTokens,
  effectiveImportance,
  MemoryStore,
  OllamaEmbeddingProvider,
  NullEmbeddingProvider,
  getEmbeddingProvider,
  migrateV1ToV2,
  KnowledgeGraph,
  extractFromToolResult,
  extractPreferencesFromMessage,
  // Promotion and semantic recall
  PromotionManager,
  isPromoted,
  daysUntilArchival,
  SemanticRecall,
  createSemanticRecall,
};

export type {
  PromotionResult,
  RecallOptions,
};

export type {
  Entity,
  Relationship,
  SubgraphResult,
  ExtractionResult,
  ExtractedEntity,
  ExtractedRelationship,
};

// ── V1 Compatibility Types ────────────────────────────────────────────

/** V1 MemoryLayer alias */
export type MemoryLayer = "session" | "project" | "global";

export interface MemoryEntry {
  id: string;
  fact: string;
  layer: MemoryLayer;
  tags: string[];
  createdAt: string;
  source?: string;
}

export interface RecallResult {
  entry: MemoryEntry;
  score: number;
}

// ── Remember Options ──────────────────────────────────────────────────

export interface RememberOptions {
  type?: MemoryType;
  scope?: MemoryScope;
  importance?: number;
  source?: SourceType;
  sourceId?: string;
  tags?: string[];
  category?: SemanticCategory | CoreCategory;
  key?: string;
  confidence?: number;
}

// ── MemoryManager v2 ─────────────────────────────────────────────────

export class MemoryManager {
  private projectStore: MemoryStore | null = null;
  private globalStore: MemoryStore | null = null;
  private workingDirectory: string;
  private workingMemoryCache: Map<string, WorkingMemory> = new Map();
  private embeddingProvider: EmbeddingProvider | null = null;
  private initialized = false;
  private graph: KnowledgeGraph | null = null;

  // V1 compat paths
  private projectJsonlPath: string;
  private globalJsonlPath: string;

  private userId: string | null = null;

  constructor(workingDirectory: string) {
    this.workingDirectory = workingDirectory;
    const globalDataDir = process.env.EIGHT_DATA_DIR || path.join(os.homedir(), ".8gent");
    this.projectJsonlPath = path.join(workingDirectory, ".8gent", "memory", "project.jsonl");
    this.globalJsonlPath = path.join(globalDataDir, "memory", "global.jsonl");
  }

  /**
   * Set the user ID for user-scoped memory operations.
   * User-scoped memories get a 1.5x relevance boost during recall.
   */
  setUserId(userId: string): void {
    this.userId = userId;
  }

  /**
   * Initialize SQLite stores and embedding provider.
   * Called lazily on first operation, or explicitly for eager init.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    try {
      // Initialize embedding provider
      this.embeddingProvider = await getEmbeddingProvider();

      // Create project store
      const projectDbDir = path.join(this.workingDirectory, ".8gent", "memory");
      ensureDir(projectDbDir);
      const projectDbPath = path.join(projectDbDir, "memory.db");
      this.projectStore = new MemoryStore(projectDbPath, this.embeddingProvider);

      // Create global store (EIGHT_DATA_DIR for cloud deployments)
      const globalBase = process.env.EIGHT_DATA_DIR || path.join(os.homedir(), ".8gent");
      const globalDbDir = path.join(globalBase, "memory");
      ensureDir(globalDbDir);
      const globalDbPath = path.join(globalDbDir, "memory.db");
      this.globalStore = new MemoryStore(globalDbPath, this.embeddingProvider);

      this.initialized = true;
    } catch (error) {
      // SQLite might not be available — fall back to v1 behavior
      console.error("[memory-v2] Failed to initialize SQLite stores:", error);
      this.initialized = false;
    }
  }

  // ── Core API ──────────────────────────────────────────────────────

  /**
   * Store a memory. Auto-classifies, embeds, and persists.
   * Returns the memory ID.
   *
   * V1 compatible: remember(fact, "project", { tags, source })
   * V2 enhanced:   remember(content, "semantic", { scope: "project", importance: 0.8 })
   */
  async remember(
    content: string,
    typeOrLayer: MemoryType | MemoryLayer,
    options?: RememberOptions & { tags?: string[]; source?: string }
  ): Promise<string> {
    await this.init();

    // Detect v1-style call: layer = "session" | "project" | "global"
    if (typeOrLayer === "session" || typeOrLayer === "project" || typeOrLayer === "global") {
      return this._rememberV1(content, typeOrLayer as MemoryLayer, options);
    }

    const memoryType = typeOrLayer as MemoryType;
    const scope = options?.scope ?? "project";
    const now = Date.now();

    const memory = this._buildMemory(content, memoryType, scope, now, options);
    const store = this._getStore(scope);

    if (store) {
      return store.write(memory);
    }

    // Fallback: write to JSONL (v1 style)
    return this._rememberV1(content, scope === "global" ? "global" : "project", options);
  }

  /**
   * Hybrid search across all memory layers.
   * Returns results sorted by relevance.
   *
   * V1 compatible: recall(query, 10) — returns RecallResult[]
   * V2 enhanced:   recall(query, { types, scope, minImportance }) — returns SearchResult[]
   */
  async recall(
    query: string,
    optionsOrLimit?: SearchOptions | number
  ): Promise<SearchResult[] | RecallResult[]> {
    await this.init();

    // V1 compat: recall(query, limit)
    if (typeof optionsOrLimit === "number") {
      return this._recallV1(query, optionsOrLimit);
    }

    const options = optionsOrLimit ?? {};
    const results: SearchResult[] = [];

    // Search project store
    if (this.projectStore) {
      const projectResults = await this.projectStore.recall(query, options);
      results.push(...projectResults);
    }

    // Search global store
    if (this.globalStore) {
      const globalResults = await this.globalStore.recall(query, options);
      results.push(...globalResults);
    }

    // Check working memory cache
    if (!options.types || options.types.includes("working")) {
      const workingResults = this._searchWorkingMemory(query);
      results.push(...workingResults);
    }

    // Deduplicate by ID and sort
    const seen = new Set<string>();
    const unique = results.filter((r) => {
      if (seen.has(r.memory.id)) return false;
      seen.add(r.memory.id);
      return true;
    });

    unique.sort((a, b) => b.score - a.score);
    return unique.slice(0, options.limit ?? 10);
  }

  /**
   * Soft delete a memory with version history.
   * Returns true if the memory was found and deleted.
   */
  async forget(id: string, reason?: string): Promise<boolean> {
    await this.init();

    // Try working memory
    if (this.workingMemoryCache.has(id)) {
      this.workingMemoryCache.delete(id);
      return true;
    }

    // Try project store
    if (this.projectStore?.forget(id, reason)) return true;

    // Try global store
    if (this.globalStore?.forget(id, reason)) return true;

    return false;
  }

  /**
   * Update an existing memory.
   */
  async update(
    id: string,
    updates: Partial<Memory>,
    reason: string,
    changedBy = "user"
  ): Promise<boolean> {
    await this.init();

    if (this.projectStore?.update(id, updates, reason, changedBy)) return true;
    if (this.globalStore?.update(id, updates, reason, changedBy)) return true;

    return false;
  }

  // ── Context Assembly ──────────────────────────────────────────────

  /**
   * Assemble context for prompt injection within a token budget.
   *
   * Budget allocation:
   *   15% — Working memory (active session context)
   *   25% — Core knowledge (architecture, conventions)
   *   30% — Semantic facts (preferences, patterns)
   *   30% — Episodic events (what happened recently)
   */
  async getContext(optionsOrMaxTokens?: ContextWindowOptions | number): Promise<ContextWindow | string> {
    await this.init();

    // V1 compat: getContext(maxTokens) returns string
    if (typeof optionsOrMaxTokens === "number") {
      const result = await this._assembleContext({ maxTokens: optionsOrMaxTokens });
      return result.text;
    }

    // V2: returns full ContextWindow
    if (optionsOrMaxTokens === undefined) {
      return this._assembleContext({});
    }
    return this._assembleContext(optionsOrMaxTokens);
  }

  // ── Working Memory ────────────────────────────────────────────────

  /**
   * Set a working memory entry (session-scoped, TTL-based).
   */
  setWorkingMemory(
    sessionId: string,
    key: string,
    value: string,
    options?: { priority?: number; ttlMs?: number }
  ): string {
    const now = Date.now();
    const ttlMs = options?.ttlMs ?? 30 * 60 * 1000; // 30 minutes default

    const memory: WorkingMemory = {
      id: generateId("mem"),
      type: "working",
      scope: "session",
      sessionId,
      key,
      value,
      priority: options?.priority ?? 5,
      ttlMs,
      expiresAt: now + ttlMs,
      importance: 0.8,
      decayFactor: 1.0,
      accessCount: 0,
      lastAccessed: now,
      createdAt: now,
      updatedAt: now,
      version: 1,
      source: "observation",
    };

    this.workingMemoryCache.set(memory.id, memory);
    return memory.id;
  }

  /**
   * Clean expired working memory entries.
   */
  cleanExpiredWorkingMemory(): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, mem] of this.workingMemoryCache) {
      if (mem.expiresAt <= now) {
        this.workingMemoryCache.delete(id);
        cleaned++;
      }
    }
    return cleaned;
  }

  // ── Migration ─────────────────────────────────────────────────────

  /**
   * Migrate v1 JSONL files to v2 SQLite.
   * Safe to call multiple times (idempotent).
   */
  async migrateFromV1(): Promise<MigrationResult> {
    await this.init();

    if (!this.projectStore || !this.globalStore) {
      return {
        projectMigrated: 0,
        globalMigrated: 0,
        skipped: 0,
        errors: ["SQLite stores not initialized"],
        duration: 0,
      };
    }

    return migrateV1ToV2(
      this.workingDirectory,
      this.projectStore,
      this.globalStore,
      this.embeddingProvider ?? undefined
    );
  }

  // ── Stats ─────────────────────────────────────────────────────────

  async getStats(): Promise<{
    session: number;
    project: number;
    global: number;
    v2?: {
      project: ReturnType<MemoryStore["getStats"]>;
      global: ReturnType<MemoryStore["getStats"]>;
    };
  }> {
    await this.init();

    const session = this.workingMemoryCache.size;

    if (this.projectStore && this.globalStore) {
      const projectStats = this.projectStore.getStats();
      const globalStats = this.globalStore.getStats();
      return {
        session,
        project: projectStats.total,
        global: globalStats.total,
        v2: { project: projectStats, global: globalStats },
      };
    }

    // V1 fallback
    return {
      session,
      project: readJsonlCount(this.projectJsonlPath),
      global: readJsonlCount(this.globalJsonlPath),
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  close(): void {
    this.projectStore?.close();
    this.globalStore?.close();
    this.workingMemoryCache.clear();
  }

  // ── Private: V1 Compat ────────────────────────────────────────────

  private _rememberV1(
    fact: string,
    layer: MemoryLayer,
    options?: { tags?: string[]; source?: string }
  ): string {
    const id = generateId("mem");
    const now = Date.now();

    // Convert to v2 semantic memory and store
    const scope: MemoryScope = layer === "session" ? "session" : layer;

    if (layer === "session") {
      const wm: WorkingMemory = {
        id,
        type: "working",
        scope: "session",
        sessionId: "default",
        key: fact.slice(0, 40),
        value: fact,
        priority: 5,
        ttlMs: 60 * 60 * 1000,
        expiresAt: now + 60 * 60 * 1000,
        importance: 0.5,
        decayFactor: 1.0,
        accessCount: 0,
        lastAccessed: now,
        createdAt: now,
        updatedAt: now,
        version: 1,
        source: "user_explicit",
      };
      this.workingMemoryCache.set(id, wm);
      return id;
    }

    const memory: SemanticMemory = {
      id,
      type: "semantic",
      scope,
      category: "fact",
      key: fact
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .split(/\s+/)
        .filter((w) => w.length > 2)
        .slice(0, 4)
        .join("-"),
      value: fact,
      confidence: 0.6,
      evidenceCount: 1,
      tags: options?.tags ?? [],
      relatedKeys: [],
      learnedAt: now,
      lastConfirmed: now,
      importance: 0.5,
      decayFactor: 1.0,
      accessCount: 0,
      lastAccessed: now,
      createdAt: now,
      updatedAt: now,
      version: 1,
      source: (options?.source as SourceType) ?? "user_explicit",
    };

    const store = this._getStore(scope);
    if (store) {
      return store.write(memory);
    }

    // Final fallback: JSONL
    const filePath = scope === "global" ? this.globalJsonlPath : this.projectJsonlPath;
    const v1Entry: MemoryEntry = {
      id,
      fact,
      layer,
      tags: options?.tags ?? [],
      createdAt: new Date().toISOString(),
      source: options?.source,
    };
    ensureDir(path.dirname(filePath));
    fs.appendFileSync(filePath, JSON.stringify(v1Entry) + "\n", "utf-8");
    return id;
  }

  private async _recallV1(query: string, limit: number): Promise<RecallResult[]> {
    // Use v2 search if available, then convert to v1 format
    const results = (await this.recall(query, { limit })) as SearchResult[];

    return results.map((r) => ({
      entry: {
        id: r.memory.id,
        fact: extractFactFromMemory(r.memory),
        layer: r.memory.scope === "session" ? "session" as MemoryLayer : r.memory.scope as MemoryLayer,
        tags: "tags" in r.memory ? (r.memory as { tags?: string[] }).tags ?? [] : [],
        createdAt: new Date(r.memory.createdAt).toISOString(),
        source: r.memory.source,
      },
      score: r.score,
    }));
  }

  // ── Private: Memory Building ──────────────────────────────────────

  private _buildMemory(
    content: string,
    type: MemoryType,
    scope: MemoryScope,
    now: number,
    options?: RememberOptions
  ): Memory {
    const base = {
      id: generateId("mem"),
      scope,
      importance: options?.importance ?? 0.5,
      decayFactor: 1.0,
      accessCount: 0,
      lastAccessed: now,
      createdAt: now,
      updatedAt: now,
      version: 1,
      source: options?.source ?? ("user_explicit" as SourceType),
      sourceId: options?.sourceId,
    };

    switch (type) {
      case "core":
        return {
          ...base,
          type: "core",
          category: (options?.category as CoreCategory) ?? "documentation",
          key: options?.key ?? generateKeyFromContent(content),
          title: content.slice(0, 80),
          content,
          confidence: options?.confidence ?? 0.7,
          evidenceCount: 1,
          tags: options?.tags ?? [],
        };

      case "episodic":
        return {
          ...base,
          type: "episodic",
          content,
          context: "",
          tags: options?.tags ?? [],
          entities: [],
          occurredAt: now,
        };

      case "semantic":
        return {
          ...base,
          type: "semantic",
          category: (options?.category as SemanticCategory) ?? "fact",
          key: options?.key ?? generateKeyFromContent(content),
          value: content,
          confidence: options?.confidence ?? 0.6,
          evidenceCount: 1,
          tags: options?.tags ?? [],
          relatedKeys: [],
          learnedAt: now,
          lastConfirmed: now,
        };

      case "procedural":
        return {
          ...base,
          type: "procedural",
          name: options?.key ?? generateKeyFromContent(content),
          description: content,
          steps: [],
          preconditions: [],
          successRate: 0.5,
          executionCount: 0,
          tags: options?.tags ?? [],
        };

      case "working":
        return {
          ...base,
          type: "working",
          scope: "session" as MemoryScope,
          sessionId: "default",
          key: options?.key ?? content.slice(0, 40),
          value: content,
          priority: 5,
          ttlMs: 30 * 60 * 1000,
          expiresAt: now + 30 * 60 * 1000,
        };

      default:
        // Default to semantic
        return {
          ...base,
          type: "semantic",
          category: "fact" as SemanticCategory,
          key: generateKeyFromContent(content),
          value: content,
          confidence: 0.6,
          evidenceCount: 1,
          tags: options?.tags ?? [],
          relatedKeys: [],
          learnedAt: now,
          lastConfirmed: now,
        };
    }
  }

  // ── Private: Context Assembly ─────────────────────────────────────

  private async _assembleContext(options: ContextWindowOptions): Promise<ContextWindow> {
    const startTime = Date.now();
    const budget = options.maxTokens ?? 2000;
    const entries: ContextEntry[] = [];
    let usedTokens = 0;

    // 1. Working memory (15% budget)
    const workingBudget = budget * 0.15;
    for (const wm of this.workingMemoryCache.values()) {
      if (wm.expiresAt <= Date.now()) continue;
      const tokens = estimateTokens(wm.value);
      if (usedTokens + tokens > workingBudget) break;
      entries.push({
        memoryId: wm.id,
        type: "working",
        content: `${wm.key}: ${wm.value}`,
        relevanceScore: 1.0,
        importance: wm.importance,
        source: wm.source,
      });
      usedTokens += tokens;
    }

    // 2. Core knowledge (25% budget)
    const coreBudget = budget * 0.40;
    if (this.projectStore) {
      const coreResults = await this.projectStore.recall(options.query ?? "", {
        types: ["core"],
        limit: 10,
        minImportance: 0.3,
      });
      for (const r of coreResults) {
        const content = extractFactFromMemory(r.memory);
        const tokens = estimateTokens(content);
        if (usedTokens + tokens > coreBudget) break;
        entries.push({
          memoryId: r.memory.id,
          type: r.memory.type,
          content,
          relevanceScore: r.score,
          importance: r.memory.importance,
          source: r.memory.source,
        });
        usedTokens += tokens;
      }
    }

    // 3. Semantic facts (30% budget)
    const semanticBudget = budget * 0.70;
    const semanticResults = await this._searchAcrossStores(options.query ?? "", {
      types: ["semantic"],
      limit: 15,
      minImportance: 0.2,
    });
    for (const r of semanticResults) {
      const content = extractFactFromMemory(r.memory);
      const tokens = estimateTokens(content);
      if (usedTokens + tokens > semanticBudget) break;
      entries.push({
        memoryId: r.memory.id,
        type: r.memory.type,
        content,
        relevanceScore: r.score,
        importance: r.memory.importance,
        source: r.memory.source,
      });
      usedTokens += tokens;
    }

    // 4. Episodic events (remaining budget)
    const episodicResults = await this._searchAcrossStores(options.query ?? "", {
      types: ["episodic"],
      limit: 10,
      minImportance: 0.3,
    });
    for (const r of episodicResults) {
      const content = extractFactFromMemory(r.memory);
      const tokens = estimateTokens(content);
      if (usedTokens + tokens > budget) break;
      entries.push({
        memoryId: r.memory.id,
        type: r.memory.type,
        content,
        relevanceScore: r.score,
        importance: r.memory.importance,
        source: r.memory.source,
      });
      usedTokens += tokens;
    }

    // Format context text
    const text = formatContextText(entries);

    // Compute stats
    const byType: Record<MemoryType, number> = {
      core: 0,
      episodic: 0,
      semantic: 0,
      procedural: 0,
      working: 0,
    };
    for (const e of entries) byType[e.type]++;

    return {
      text,
      memories: entries,
      stats: {
        totalMemories: entries.length,
        byType,
        estimatedTokens: usedTokens,
        searchLatencyMs: Date.now() - startTime,
      },
    };
  }

  private async _searchAcrossStores(
    query: string,
    options: SearchOptions
  ): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    if (this.projectStore) {
      results.push(...(await this.projectStore.recall(query, options)));
    }
    if (this.globalStore) {
      results.push(...(await this.globalStore.recall(query, options)));
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, options.limit ?? 10);
  }

  private _searchWorkingMemory(query: string): SearchResult[] {
    const queryLower = query.toLowerCase();
    const tokens = queryLower.split(/\s+/).filter((t) => t.length > 1);
    const results: SearchResult[] = [];

    for (const wm of this.workingMemoryCache.values()) {
      if (wm.expiresAt <= Date.now()) continue;
      const searchable = `${wm.key} ${wm.value}`.toLowerCase();
      let matches = 0;
      for (const t of tokens) {
        if (searchable.includes(t)) matches++;
      }
      if (matches > 0) {
        results.push({
          memory: wm,
          score: tokens.length > 0 ? matches / tokens.length : 0,
          matchType: "fts",
        });
      }
    }

    return results;
  }

  private _getStore(scope: MemoryScope): MemoryStore | null {
    if (scope === "global") return this.globalStore;
    return this.projectStore;
  }

  // ── V1 Compat Accessors ───────────────────────────────────────────

  getSessionMemories(): MemoryEntry[] {
    return Array.from(this.workingMemoryCache.values()).map((wm) => ({
      id: wm.id,
      fact: wm.value,
      layer: "session" as MemoryLayer,
      tags: [],
      createdAt: new Date(wm.createdAt).toISOString(),
      source: wm.source,
    }));
  }

  getProjectMemories(): MemoryEntry[] {
    // Read from JSONL for v1 compat
    return readJsonlSafe(this.projectJsonlPath);
  }

  getGlobalMemories(): MemoryEntry[] {
    return readJsonlSafe(this.globalJsonlPath);
  }

  // ── Knowledge Graph ──────────────────────────────────────────────────

  /**
   * Get the knowledge graph (lazy-initialized from project store).
   */
  async getGraph(): Promise<KnowledgeGraph> {
    if (this.graph) return this.graph;
    await this.init();
    this.graph = new KnowledgeGraph(this.projectStore!);
    return this.graph;
  }

  // ── Ingestion Pipeline ───────────────────────────────────────────────

  /**
   * Ingest a tool result — extracts entities, relationships, and stores them.
   * Called from the agent loop after each tool execution.
   */
  async ingestToolResult(
    toolName: string,
    args: Record<string, unknown>,
    result: unknown,
  ): Promise<ExtractionResult | null> {
    try {
      const extraction = extractFromToolResult(toolName, args, result);
      if (!extraction || extraction.entities.length === 0) {
        return null;
      }
      await this.applyExtraction(extraction);
      return extraction;
    } catch {
      return null;
    }
  }

  /**
   * Ingest a user message — extracts preferences and entities.
   * Called from the agent loop when user sends a message.
   */
  async ingestUserMessage(message: string): Promise<ExtractionResult | null> {
    try {
      const extraction = extractPreferencesFromMessage(message);
      if (!extraction || extraction.entities.length === 0) {
        return null;
      }
      await this.applyExtraction(extraction);
      return extraction;
    } catch {
      return null;
    }
  }

  /**
   * Apply an extraction result — add entities and relationships to graph.
   */
  private async applyExtraction(extraction: ExtractionResult): Promise<void> {
    const graph = await this.getGraph();

    // Add entities to knowledge graph, track name→id mapping
    const nameToId = new Map<string, string>();
    for (const entity of extraction.entities) {
      const id = graph.addEntity(entity.type, entity.name, {
        description: entity.description,
        metadata: entity.metadata,
      });
      nameToId.set(entity.name, id);
    }

    // Add relationships (resolve names to entity IDs)
    for (const rel of extraction.relationships) {
      const fromId = nameToId.get(rel.fromName);
      const toId = nameToId.get(rel.toName);
      if (fromId && toId) {
        graph.addRelationship(fromId, toId, rel.type, rel.metadata);
      }
    }
  }
}

// ── Singleton ─────────────────────────────────────────────────────────

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

/** Alias for v2 consumers */
export const getMemoryManagerV2 = getMemoryManager;

export function resetMemoryManager(): void {
  _instance?.close();
  _instance = null;
}

// ── V1 Compat: extractAutoMemories ──────────────────────────────────

/**
 * Analyze a tool call result and extract facts worth remembering.
 * V1 compat — kept for backwards compatibility with agent.ts integration.
 */
export function extractAutoMemories(
  toolName: string,
  args: Record<string, unknown>,
  result: string
): { fact: string; layer: MemoryLayer }[] {
  const facts: { fact: string; layer: MemoryLayer }[] = [];

  if (toolName === "read_file" && String(args.path || "").endsWith("package.json")) {
    try {
      const pkg = JSON.parse(result);
      if (pkg.name) facts.push({ fact: `Project name: ${pkg.name}`, layer: "project" });
      if (pkg.description) facts.push({ fact: `Project description: ${pkg.description}`, layer: "project" });

      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const significant = Object.keys(deps).filter((d) =>
        ["react", "vue", "svelte", "next", "nuxt", "express", "fastify", "hono", "bun", "typescript", "tailwindcss", "prisma", "drizzle", "supabase"].includes(d)
      );
      if (significant.length > 0) {
        facts.push({ fact: `Tech stack includes: ${significant.join(", ")}`, layer: "project" });
      }
    } catch {
      // skip
    }
  }

  if (toolName === "read_file" && String(args.path || "").includes("tsconfig")) {
    facts.push({ fact: `Project uses TypeScript (found ${args.path})`, layer: "project" });
  }

  if (toolName === "read_file" && /dockerfile|docker-compose/i.test(String(args.path || ""))) {
    facts.push({ fact: `Project uses Docker (found ${args.path})`, layer: "project" });
  }

  if (toolName === "run_command") {
    const cmd = String(args.command || "");
    if (cmd.includes("node --version") || cmd.includes("bun --version")) {
      facts.push({ fact: `Runtime version: ${result.trim()}`, layer: "project" });
    }
    if (cmd.includes("test") && result.includes("pass")) {
      facts.push({ fact: `Tests are passing (ran: ${cmd.slice(0, 60)})`, layer: "session" });
    }
  }

  if (toolName === "read_file" && /readme/i.test(String(args.path || ""))) {
    const lines = result.split("\n").filter((l) => l.trim() && !l.startsWith("#") && l.length > 20);
    if (lines.length > 0) {
      facts.push({ fact: `Project purpose: ${lines[0].trim().slice(0, 200)}`, layer: "project" });
    }
  }

  return facts;
}

// ── Helpers ───────────────────────────────────────────────────────────

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function generateKeyFromContent(content: string): string {
  return content
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 4)
    .join("-");
}

function extractFactFromMemory(memory: Memory): string {
  switch (memory.type) {
    case "core":
      return memory.summary ?? memory.content;
    case "episodic":
      return memory.summary ?? memory.content;
    case "semantic":
      return memory.value;
    case "procedural":
      return `${memory.name}: ${memory.description}`;
    case "working":
      return `${memory.key}: ${memory.value}`;
    default:
      return "";
  }
}

function formatContextText(entries: ContextEntry[]): string {
  if (entries.length === 0) return "";

  const sections: string[] = ["[Memory Context]"];

  const working = entries.filter((e) => e.type === "working");
  const core = entries.filter((e) => e.type === "core");
  const semantic = entries.filter((e) => e.type === "semantic");
  const episodic = entries.filter((e) => e.type === "episodic");
  const procedural = entries.filter((e) => e.type === "procedural");

  if (working.length > 0) {
    sections.push("\n## Active Context");
    for (const e of working) sections.push(`- ${e.content}`);
  }

  if (core.length > 0) {
    sections.push("\n## Project Knowledge");
    for (const e of core) sections.push(`- ${e.content}`);
  }

  if (semantic.length > 0) {
    sections.push("\n## Known Facts");
    for (const e of semantic) sections.push(`- ${e.content}`);
  }

  if (episodic.length > 0) {
    sections.push("\n## Recent Events");
    for (const e of episodic) sections.push(`- ${e.content}`);
  }

  if (procedural.length > 0) {
    sections.push("\n## Procedures");
    for (const e of procedural) sections.push(`- ${e.content}`);
  }

  return sections.join("\n");
}

function readJsonlSafe(filePath: string): MemoryEntry[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    return fs
      .readFileSync(filePath, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as MemoryEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is MemoryEntry => e !== null);
  } catch {
    return [];
  }
}

function readJsonlCount(filePath: string): number {
  if (!fs.existsSync(filePath)) return 0;
  try {
    return fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}
