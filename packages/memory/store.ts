/**
 * Memory v2 SQLite Storage Backend
 *
 * Uses bun:sqlite with WAL mode for concurrent reads.
 * Implements FTS5 full-text search + optional vector cosine similarity.
 *
 * Tables: memories, embeddings, memory_versions, entities, relationships,
 *         entity_mentions, memory_relationships, consolidation_log
 */

import { Database } from "bun:sqlite";
import {
  type Memory,
  type MemoryType,
  type MemoryScope,
  type SourceType,
  type SearchOptions,
  type SearchResult,
  type Entity,
  type EntityType,
  type Relationship,
  type RelationshipType,
  generateId,
  effectiveImportance,
} from "./types.js";
import { type EmbeddingProvider, cosineSimilarity } from "./embeddings.js";

// ── Schema SQL ────────────────────────────────────────────────────────

const SCHEMA_SQL = `
-- Core memories table
CREATE TABLE IF NOT EXISTS memories (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  scope         TEXT NOT NULL,
  data          TEXT NOT NULL,
  content_text  TEXT NOT NULL,
  tags          TEXT,
  importance    REAL NOT NULL DEFAULT 0.5,
  decay_factor  REAL NOT NULL DEFAULT 1.0,
  access_count  INTEGER NOT NULL DEFAULT 0,
  last_accessed INTEGER,
  confidence    REAL,
  evidence_count INTEGER DEFAULT 0,
  version       INTEGER NOT NULL DEFAULT 1,
  source        TEXT NOT NULL,
  source_id     TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER
);

-- Embeddings table (separate for large blob storage)
CREATE TABLE IF NOT EXISTS embeddings (
  memory_id     TEXT PRIMARY KEY REFERENCES memories(id),
  model         TEXT NOT NULL,
  dimensions    INTEGER NOT NULL,
  vector        BLOB NOT NULL,
  created_at    INTEGER NOT NULL
);

-- Full-text search index
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content_text,
  tags,
  content='memories',
  content_rowid='rowid'
);

-- FTS sync triggers
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content_text, tags)
  VALUES (new.rowid, new.content_text, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content_text, tags)
  VALUES ('delete', old.rowid, old.content_text, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content_text, tags)
  VALUES ('delete', old.rowid, old.content_text, old.tags);
  INSERT INTO memories_fts(rowid, content_text, tags)
  VALUES (new.rowid, new.content_text, new.tags);
END;

-- Knowledge graph tables
CREATE TABLE IF NOT EXISTS entities (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  metadata      TEXT,
  first_seen    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL,
  mention_count INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS relationships (
  id            TEXT PRIMARY KEY,
  source_id     TEXT NOT NULL REFERENCES entities(id),
  target_id     TEXT NOT NULL REFERENCES entities(id),
  type          TEXT NOT NULL,
  strength      REAL NOT NULL DEFAULT 0.5,
  metadata      TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(source_id, target_id, type)
);

CREATE TABLE IF NOT EXISTS entity_mentions (
  entity_id     TEXT NOT NULL REFERENCES entities(id),
  memory_id     TEXT NOT NULL REFERENCES memories(id),
  context       TEXT,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (entity_id, memory_id)
);

CREATE TABLE IF NOT EXISTS memory_relationships (
  id            TEXT PRIMARY KEY,
  source_id     TEXT NOT NULL REFERENCES memories(id),
  target_id     TEXT NOT NULL REFERENCES memories(id),
  type          TEXT NOT NULL,
  strength      REAL NOT NULL DEFAULT 0.5,
  created_at    INTEGER NOT NULL,
  UNIQUE(source_id, target_id, type)
);

CREATE TABLE IF NOT EXISTS consolidation_log (
  id            TEXT PRIMARY KEY,
  level         TEXT NOT NULL,
  source_ids    TEXT NOT NULL,
  result_id     TEXT REFERENCES memories(id),
  status        TEXT NOT NULL DEFAULT 'pending',
  error         TEXT,
  started_at    INTEGER,
  completed_at  INTEGER,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_versions (
  id            TEXT PRIMARY KEY,
  memory_id     TEXT NOT NULL REFERENCES memories(id),
  version       INTEGER NOT NULL,
  data_snapshot TEXT NOT NULL,
  changed_by    TEXT NOT NULL,
  change_reason TEXT,
  created_at    INTEGER NOT NULL
);
`;

const INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope);
CREATE INDEX IF NOT EXISTS idx_memories_type_scope ON memories(type, scope);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source);
CREATE INDEX IF NOT EXISTS idx_memories_deleted ON memories(deleted_at);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
CREATE INDEX IF NOT EXISTS idx_relationships_source ON relationships(source_id);
CREATE INDEX IF NOT EXISTS idx_relationships_target ON relationships(target_id);
CREATE INDEX IF NOT EXISTS idx_relationships_type ON relationships(type);
CREATE INDEX IF NOT EXISTS idx_versions_memory ON memory_versions(memory_id, version DESC);
`;

// ── MemoryStore ───────────────────────────────────────────────────────

export class MemoryStore {
  private db: Database;
  private embeddingProvider: EmbeddingProvider | null;

  constructor(dbPath: string, embeddingProvider?: EmbeddingProvider) {
    this.db = new Database(dbPath, { create: true });
    this.embeddingProvider = embeddingProvider ?? null;

    // Configure WAL mode and pragmas
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("cache_size = -64000"); // 64MB cache
    this.db.pragma("foreign_keys = ON");

    // Initialize schema
    this.db.exec(SCHEMA_SQL);
    this.db.exec(INDEXES_SQL);
  }

  /** Set or update the embedding provider (e.g., after Ollama becomes available) */
  setEmbeddingProvider(provider: EmbeddingProvider): void {
    this.embeddingProvider = provider;
  }

  // ── Write ─────────────────────────────────────────────────────────

  /**
   * Store a memory. Generates an embedding asynchronously if provider is available.
   * Returns the memory ID.
   */
  write(memory: Memory): string {
    const now = Date.now();
    const id = memory.id || generateId("mem");
    const contentText = extractContentText(memory);
    const tags = extractTags(memory);
    const data = JSON.stringify(memory);

    const stmt = this.db.prepare(`
      INSERT INTO memories (id, type, scope, data, content_text, tags, importance, decay_factor,
        access_count, last_accessed, confidence, evidence_count, version, source, source_id,
        created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      memory.type,
      memory.scope,
      data,
      contentText,
      JSON.stringify(tags),
      memory.importance,
      memory.decayFactor,
      memory.accessCount,
      memory.lastAccessed || null,
      "confidence" in memory ? (memory as { confidence?: number }).confidence ?? null : null,
      "evidenceCount" in memory ? (memory as { evidenceCount?: number }).evidenceCount ?? 0 : 0,
      memory.version,
      memory.source,
      memory.sourceId || null,
      memory.createdAt || now,
      memory.updatedAt || now
    );

    // Generate embedding asynchronously (non-blocking)
    if (this.embeddingProvider?.available) {
      this._embedAsync(id, contentText).catch(() => {
        // Silently fail — memory is stored, embedding is optional
      });
    }

    return id;
  }

  /**
   * Write multiple memories in a single transaction.
   */
  writeBatch(memories: Memory[]): string[] {
    const ids: string[] = [];
    const transaction = this.db.transaction(() => {
      for (const memory of memories) {
        ids.push(this.write(memory));
      }
    });
    transaction();
    return ids;
  }

  // ── Read / Recall ─────────────────────────────────────────────────

  /**
   * Get a memory by ID. Returns null if not found or soft-deleted.
   */
  get(id: string, includeDeleted = false): Memory | null {
    const where = includeDeleted ? "" : "AND deleted_at IS NULL";
    const row = this.db
      .prepare(`SELECT data, access_count FROM memories WHERE id = ? ${where}`)
      .get(id) as { data: string; access_count: number } | null;

    if (!row) return null;

    // Bump access count
    this.db
      .prepare("UPDATE memories SET access_count = access_count + 1, last_accessed = ? WHERE id = ?")
      .run(Date.now(), id);

    return JSON.parse(row.data) as Memory;
  }

  /**
   * Hybrid search: FTS5 BM25 + optional vector cosine similarity.
   * Falls back to FTS-only if embeddings are unavailable.
   */
  async recall(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const limit = options.limit ?? 10;
    const startTime = Date.now();

    // FTS5 search
    const ftsResults = this._ftsSearch(query, options);

    // Vector search (if embedding provider available)
    let vectorResults: SearchResult[] = [];
    if (this.embeddingProvider?.available && query) {
      try {
        const queryEmbedding = await this.embeddingProvider.generate(query);
        vectorResults = this._vectorSearch(queryEmbedding, options);
      } catch {
        // Fall back to FTS-only on embedding failure
      }
    }

    // If we have both, fuse with Reciprocal Rank Fusion
    let results: SearchResult[];
    if (vectorResults.length > 0) {
      results = this._fuseResults(ftsResults, vectorResults, limit);
    } else {
      results = ftsResults.slice(0, limit);
    }

    // Post-process: apply importance weighting and recency boost
    for (const result of results) {
      const eff = effectiveImportance(result.memory);
      result.score *= 0.7 + 0.3 * eff;
    }

    // Sort final results
    results.sort((a, b) => b.score - a.score);

    // Bump access counts for returned results
    const updateStmt = this.db.prepare(
      "UPDATE memories SET access_count = access_count + 1, last_accessed = ? WHERE id = ?"
    );
    const now = Date.now();
    for (const r of results) {
      updateStmt.run(now, r.memory.id);
    }

    return results.slice(0, limit);
  }

  // ── Update ────────────────────────────────────────────────────────

  /**
   * Update a memory. Creates a version snapshot before applying changes.
   */
  update(
    id: string,
    updates: Partial<Memory>,
    reason: string,
    changedBy: string
  ): boolean {
    const row = this.db
      .prepare("SELECT data, version FROM memories WHERE id = ? AND deleted_at IS NULL")
      .get(id) as { data: string; version: number } | null;

    if (!row) return false;

    const current = JSON.parse(row.data) as Memory;
    const now = Date.now();

    // Create version snapshot
    this.db
      .prepare(
        `INSERT INTO memory_versions (id, memory_id, version, data_snapshot, changed_by, change_reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(generateId("ver"), id, row.version, row.data, changedBy, reason, now);

    // Merge updates
    const merged = { ...current, ...updates, updatedAt: now, version: row.version + 1 };
    const contentText = extractContentText(merged as Memory);
    const tags = extractTags(merged as Memory);

    this.db
      .prepare(
        `UPDATE memories SET data = ?, content_text = ?, tags = ?, importance = ?,
         confidence = ?, evidence_count = ?, version = ?, updated_at = ? WHERE id = ?`
      )
      .run(
        JSON.stringify(merged),
        contentText,
        JSON.stringify(tags),
        merged.importance,
        "confidence" in merged ? (merged as { confidence?: number }).confidence ?? null : null,
        "evidenceCount" in merged ? (merged as { evidenceCount?: number }).evidenceCount ?? 0 : 0,
        merged.version,
        now,
        id
      );

    // Re-embed if content changed
    if (this.embeddingProvider?.available) {
      this._embedAsync(id, contentText).catch(() => {});
    }

    return true;
  }

  // ── Forget (Soft Delete) ──────────────────────────────────────────

  /**
   * Soft delete a memory. Creates a version snapshot first.
   * Returns true if the memory was found and deleted.
   */
  forget(id: string, reason?: string): boolean {
    const row = this.db
      .prepare("SELECT data, version FROM memories WHERE id = ? AND deleted_at IS NULL")
      .get(id) as { data: string; version: number } | null;

    if (!row) return false;

    const now = Date.now();

    // Create version snapshot before deletion
    this.db
      .prepare(
        `INSERT INTO memory_versions (id, memory_id, version, data_snapshot, changed_by, change_reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(generateId("ver"), id, row.version, row.data, "user", reason || "deleted", now);

    // Soft delete
    this.db.prepare("UPDATE memories SET deleted_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);

    return true;
  }

  // ── Knowledge Graph ───────────────────────────────────────────────

  addEntity(entity: Omit<Entity, "id" | "createdAt" | "updatedAt">): string {
    const id = generateId("ent");
    const now = Date.now();

    this.db
      .prepare(
        `INSERT INTO entities (id, type, name, description, metadata, first_seen, last_seen, mention_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        entity.type,
        entity.name,
        entity.description || null,
        entity.metadata ? JSON.stringify(entity.metadata) : null,
        entity.firstSeen,
        entity.lastSeen,
        entity.mentionCount,
        now,
        now
      );

    return id;
  }

  getEntity(id: string): Entity | null {
    const row = this.db.prepare("SELECT * FROM entities WHERE id = ?").get(id) as Record<string, unknown> | null;
    if (!row) return null;
    return rowToEntity(row);
  }

  findEntities(query: { type?: EntityType; name?: string; limit?: number }): Entity[] {
    let sql = "SELECT * FROM entities WHERE 1=1";
    const params: unknown[] = [];

    if (query.type) {
      sql += " AND type = ?";
      params.push(query.type);
    }
    if (query.name) {
      sql += " AND name LIKE ?";
      params.push(`%${query.name}%`);
    }
    sql += ` ORDER BY mention_count DESC LIMIT ?`;
    params.push(query.limit ?? 20);

    return (this.db.prepare(sql).all(...params) as Record<string, unknown>[]).map(rowToEntity);
  }

  addRelationship(rel: Omit<Relationship, "id" | "createdAt" | "updatedAt">): string {
    const id = generateId("rel");
    const now = Date.now();

    this.db
      .prepare(
        `INSERT OR REPLACE INTO relationships (id, source_id, target_id, type, strength, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        rel.sourceId,
        rel.targetId,
        rel.type,
        rel.strength,
        rel.metadata ? JSON.stringify(rel.metadata) : null,
        now,
        now
      );

    return id;
  }

  getRelationships(
    entityId: string,
    direction: "outgoing" | "incoming" | "both" = "both"
  ): Relationship[] {
    let sql: string;
    const params: string[] = [];

    if (direction === "outgoing") {
      sql = "SELECT * FROM relationships WHERE source_id = ?";
      params.push(entityId);
    } else if (direction === "incoming") {
      sql = "SELECT * FROM relationships WHERE target_id = ?";
      params.push(entityId);
    } else {
      sql = "SELECT * FROM relationships WHERE source_id = ? OR target_id = ?";
      params.push(entityId, entityId);
    }

    return (this.db.prepare(sql).all(...params) as Record<string, unknown>[]).map(rowToRelationship);
  }

  linkEntityToMemory(entityId: string, memoryId: string, context?: string): void {
    const now = Date.now();
    this.db
      .prepare(
        "INSERT OR IGNORE INTO entity_mentions (entity_id, memory_id, context, created_at) VALUES (?, ?, ?, ?)"
      )
      .run(entityId, memoryId, context || null, now);

    // Bump entity mention count and last_seen
    this.db
      .prepare("UPDATE entities SET mention_count = mention_count + 1, last_seen = ?, updated_at = ? WHERE id = ?")
      .run(now, now, entityId);
  }

  // ── Stats ─────────────────────────────────────────────────────────

  getStats(): {
    total: number;
    byType: Record<MemoryType, number>;
    byScope: Record<MemoryScope, number>;
    entities: number;
    relationships: number;
    embeddingsCount: number;
  } {
    const total = (
      this.db.prepare("SELECT COUNT(*) as c FROM memories WHERE deleted_at IS NULL").get() as { c: number }
    ).c;

    const byType: Record<string, number> = { core: 0, episodic: 0, semantic: 0, procedural: 0, working: 0 };
    const typeRows = this.db
      .prepare("SELECT type, COUNT(*) as c FROM memories WHERE deleted_at IS NULL GROUP BY type")
      .all() as Array<{ type: string; c: number }>;
    for (const r of typeRows) byType[r.type] = r.c;

    const byScope: Record<string, number> = { session: 0, project: 0, global: 0 };
    const scopeRows = this.db
      .prepare("SELECT scope, COUNT(*) as c FROM memories WHERE deleted_at IS NULL GROUP BY scope")
      .all() as Array<{ scope: string; c: number }>;
    for (const r of scopeRows) byScope[r.scope] = r.c;

    const entities = (this.db.prepare("SELECT COUNT(*) as c FROM entities").get() as { c: number }).c;
    const relationships = (this.db.prepare("SELECT COUNT(*) as c FROM relationships").get() as { c: number }).c;
    const embeddingsCount = (this.db.prepare("SELECT COUNT(*) as c FROM embeddings").get() as { c: number }).c;

    return {
      total,
      byType: byType as Record<MemoryType, number>,
      byScope: byScope as Record<MemoryScope, number>,
      entities,
      relationships,
      embeddingsCount,
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  close(): void {
    this.db.close();
  }

  /** Get the raw database handle (for advanced operations / migration) */
  getDb(): Database {
    return this.db;
  }

  // ── Private: FTS5 Search ──────────────────────────────────────────

  private _ftsSearch(query: string, options: SearchOptions): SearchResult[] {
    if (!query) return [];

    // Build FTS5 query — escape special chars and use OR for partial matching
    const ftsQuery = query
      .replace(/['"(){}[\]*+?\\^$|]/g, "")
      .split(/\s+/)
      .filter((t) => t.length > 1)
      .map((t) => `"${t}"`)
      .join(" OR ");

    if (!ftsQuery) return [];

    let sql = `
      SELECT m.rowid, m.id, m.data, m.importance, m.type, m.scope,
             m.access_count, m.last_accessed, m.created_at, m.decay_factor,
             m.confidence,
             rank
      FROM memories_fts fts
      JOIN memories m ON m.rowid = fts.rowid
      WHERE memories_fts MATCH ?
        AND m.deleted_at IS NULL
    `;
    const params: unknown[] = [ftsQuery];

    if (options.types && options.types.length > 0) {
      sql += ` AND m.type IN (${options.types.map(() => "?").join(",")})`;
      params.push(...options.types);
    }
    if (options.scope) {
      sql += " AND m.scope = ?";
      params.push(options.scope);
    }
    if (options.minImportance) {
      sql += " AND m.importance >= ?";
      params.push(options.minImportance);
    }

    sql += " ORDER BY rank LIMIT ?";
    params.push((options.limit ?? 10) * 2); // Fetch extra for fusion

    try {
      const rows = this.db.prepare(sql).all(...params) as Array<{
        id: string;
        data: string;
        rank: number;
        importance: number;
      }>;

      return rows.map((row, index) => ({
        memory: JSON.parse(row.data) as Memory,
        score: 1 / (60 + index + 1), // BM25 rank to RRF score
        matchType: "fts" as const,
      }));
    } catch {
      // FTS query might fail on malformed input — return empty
      return [];
    }
  }

  // ── Private: Vector Search ────────────────────────────────────────

  private _vectorSearch(queryEmbedding: Float32Array, options: SearchOptions): SearchResult[] {
    let sql = `
      SELECT e.memory_id, e.vector, m.data, m.importance, m.type, m.scope
      FROM embeddings e
      JOIN memories m ON m.id = e.memory_id
      WHERE m.deleted_at IS NULL
    `;
    const params: unknown[] = [];

    if (options.types && options.types.length > 0) {
      sql += ` AND m.type IN (${options.types.map(() => "?").join(",")})`;
      params.push(...options.types);
    }
    if (options.scope) {
      sql += " AND m.scope = ?";
      params.push(options.scope);
    }
    if (options.minImportance) {
      sql += " AND m.importance >= ?";
      params.push(options.minImportance);
    }

    const rows = this.db.prepare(sql).all(...params) as Array<{
      memory_id: string;
      vector: Buffer;
      data: string;
      importance: number;
    }>;

    const results: SearchResult[] = [];
    const minScore = 0.3; // Minimum cosine similarity threshold

    for (const row of rows) {
      const vector = new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4);
      const similarity = cosineSimilarity(queryEmbedding, vector);

      if (similarity >= minScore) {
        results.push({
          memory: JSON.parse(row.data) as Memory,
          score: similarity * (0.7 + 0.3 * row.importance),
          matchType: "vector",
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, (options.limit ?? 10) * 2);
  }

  // ── Private: Reciprocal Rank Fusion ───────────────────────────────

  private _fuseResults(
    ftsResults: SearchResult[],
    vectorResults: SearchResult[],
    limit: number
  ): SearchResult[] {
    const K = 60; // Standard RRF constant
    const FTS_WEIGHT = 0.4;
    const VECTOR_WEIGHT = 0.6;

    const scoreMap = new Map<string, { score: number; memory: Memory }>();

    // FTS scores
    for (let i = 0; i < ftsResults.length; i++) {
      const r = ftsResults[i];
      const rrfScore = FTS_WEIGHT * (1 / (K + i + 1));
      const existing = scoreMap.get(r.memory.id);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scoreMap.set(r.memory.id, { score: rrfScore, memory: r.memory });
      }
    }

    // Vector scores
    for (let i = 0; i < vectorResults.length; i++) {
      const r = vectorResults[i];
      const rrfScore = VECTOR_WEIGHT * (1 / (K + i + 1));
      const existing = scoreMap.get(r.memory.id);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scoreMap.set(r.memory.id, { score: rrfScore, memory: r.memory });
      }
    }

    return Array.from(scoreMap.values())
      .map(({ score, memory }) => ({
        memory,
        score,
        matchType: "hybrid" as const,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  // ── Private: Async Embedding ──────────────────────────────────────

  private async _embedAsync(memoryId: string, contentText: string): Promise<void> {
    if (!this.embeddingProvider?.available) return;

    const embedding = await this.embeddingProvider.generate(contentText);
    if (embedding.length === 0) return;

    const buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);

    this.db
      .prepare(
        `INSERT OR REPLACE INTO embeddings (memory_id, model, dimensions, vector, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(memoryId, this.embeddingProvider.model, this.embeddingProvider.dimensions, buffer, Date.now());
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

function extractContentText(memory: Memory): string {
  switch (memory.type) {
    case "core":
      return `${memory.title}: ${memory.content}`;
    case "episodic":
      return `${memory.content} ${memory.context || ""}`;
    case "semantic":
      return `${memory.key}: ${memory.value}`;
    case "procedural":
      return `${memory.name}: ${memory.description} ${memory.steps.map((s) => s.action).join(". ")}`;
    case "working":
      return `${memory.key}: ${memory.value}`;
    default:
      return "";
  }
}

function extractTags(memory: Memory): string[] {
  if ("tags" in memory && Array.isArray(memory.tags)) {
    return memory.tags;
  }
  return [];
}

function rowToEntity(row: Record<string, unknown>): Entity {
  return {
    id: row.id as string,
    type: row.type as EntityType,
    name: row.name as string,
    description: (row.description as string) || undefined,
    metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
    firstSeen: row.first_seen as number,
    lastSeen: row.last_seen as number,
    mentionCount: row.mention_count as number,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function rowToRelationship(row: Record<string, unknown>): Relationship {
  return {
    id: row.id as string,
    sourceId: row.source_id as string,
    targetId: row.target_id as string,
    type: row.type as RelationshipType,
    strength: row.strength as number,
    metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}
