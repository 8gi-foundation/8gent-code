/**
 * Knowledge Graph — Entity and Relationship store backed by SQLite.
 *
 * Tables live alongside the memory store in the same .8gent/memory/ database.
 * Entities are deduplicated by (type, name) composite key.
 * Relationships are deduplicated by (source_id, target_id, type) composite key.
 *
 * All single-entity lookups target <10ms via indexed queries.
 */

import { Database } from "bun:sqlite";
import * as crypto from "crypto";

// ============================================
// Types
// ============================================

export type EntityType =
  | "file"
  | "function"
  | "package"
  | "person"
  | "decision"
  | "concept"
  | "preference"
  | "tool";

export type RelationshipType =
  | "depends_on"
  | "implements"
  | "authored_by"
  | "decided"
  | "prefers"
  | "uses"
  | "contains"
  | "related_to";

export interface Entity {
  id: string;
  type: EntityType;
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
  firstSeen: number;
  lastSeen: number;
  mentionCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface Relationship {
  id: string;
  sourceId: string;
  targetId: string;
  type: RelationshipType;
  strength: number;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface SubgraphResult {
  entities: Entity[];
  relationships: Relationship[];
}

export interface PatternQuery {
  entityType?: EntityType;
  relationshipType?: RelationshipType;
  namePattern?: string;
  limit?: number;
}

// ============================================
// ID generation
// ============================================

function generateId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

// ============================================
// Row mappers
// ============================================

interface EntityRow {
  id: string;
  type: string;
  name: string;
  description: string | null;
  metadata: string | null;
  first_seen: number;
  last_seen: number;
  mention_count: number;
  created_at: number;
  updated_at: number;
}

interface RelationshipRow {
  id: string;
  source_id: string;
  target_id: string;
  type: string;
  strength: number;
  metadata: string | null;
  created_at: number;
  updated_at: number;
}

function rowToEntity(row: EntityRow): Entity {
  return {
    id: row.id,
    type: row.type as EntityType,
    name: row.name,
    description: row.description ?? undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    mentionCount: row.mention_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToRelationship(row: RelationshipRow): Relationship {
  return {
    id: row.id,
    sourceId: row.source_id,
    targetId: row.target_id,
    type: row.type as RelationshipType,
    strength: row.strength,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ============================================
// KnowledgeGraph
// ============================================

export class KnowledgeGraph {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.initSchema();
  }

  // ── Schema ─────────────────────────────────────────────────────────

  private initSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS knowledge_entities (
        id            TEXT PRIMARY KEY,
        type          TEXT NOT NULL,
        name          TEXT NOT NULL,
        description   TEXT,
        metadata      TEXT,
        first_seen    INTEGER NOT NULL,
        last_seen     INTEGER NOT NULL,
        mention_count INTEGER NOT NULL DEFAULT 1,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        UNIQUE(type, name)
      )
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_ke_type ON knowledge_entities(type)
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_ke_name ON knowledge_entities(name)
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_ke_type_name ON knowledge_entities(type, name)
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS knowledge_relationships (
        id            TEXT PRIMARY KEY,
        source_id     TEXT NOT NULL REFERENCES knowledge_entities(id),
        target_id     TEXT NOT NULL REFERENCES knowledge_entities(id),
        type          TEXT NOT NULL,
        strength      REAL NOT NULL DEFAULT 0.5,
        metadata      TEXT,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        UNIQUE(source_id, target_id, type)
      )
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_kr_source ON knowledge_relationships(source_id)
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_kr_target ON knowledge_relationships(target_id)
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_kr_type ON knowledge_relationships(type)
    `);
  }

  // ── Entities ───────────────────────────────────────────────────────

  /**
   * Add or upsert an entity. If an entity with the same (type, name) exists,
   * it increments mention_count and updates last_seen + metadata.
   * Returns the entity ID (existing or new).
   */
  addEntity(
    type: EntityType,
    name: string,
    properties?: { description?: string; metadata?: Record<string, unknown> }
  ): string {
    const now = Date.now();

    // Try to find existing entity for dedup
    const existing = this.db
      .query<EntityRow, [string, string]>(
        "SELECT * FROM knowledge_entities WHERE type = ? AND name = ?"
      )
      .get(type, name);

    if (existing) {
      // Upsert: bump mention count, update last_seen and optional fields
      const updatedMeta = properties?.metadata
        ? JSON.stringify({
            ...(existing.metadata ? JSON.parse(existing.metadata) : {}),
            ...properties.metadata,
          })
        : existing.metadata;

      this.db
        .query(
          `UPDATE knowledge_entities
           SET mention_count = mention_count + 1,
               last_seen = ?,
               description = COALESCE(?, description),
               metadata = COALESCE(?, metadata),
               updated_at = ?
           WHERE id = ?`
        )
        .run(
          now,
          properties?.description ?? null,
          updatedMeta,
          now,
          existing.id
        );

      return existing.id;
    }

    // Insert new entity
    const id = generateId("ent");
    this.db
      .query(
        `INSERT INTO knowledge_entities (id, type, name, description, metadata, first_seen, last_seen, mention_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
      )
      .run(
        id,
        type,
        name,
        properties?.description ?? null,
        properties?.metadata ? JSON.stringify(properties.metadata) : null,
        now,
        now,
        now,
        now
      );

    return id;
  }

  /**
   * Get a single entity by ID.
   */
  getEntity(id: string): Entity | null {
    const row = this.db
      .query<EntityRow, [string]>(
        "SELECT * FROM knowledge_entities WHERE id = ?"
      )
      .get(id);

    return row ? rowToEntity(row) : null;
  }

  /**
   * Find entities matching a query. Supports type filter, name substring,
   * and result limit.
   */
  findEntities(query: {
    type?: EntityType;
    name?: string;
    limit?: number;
  }): Entity[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.type) {
      conditions.push("type = ?");
      params.push(query.type);
    }

    if (query.name) {
      conditions.push("name LIKE ?");
      params.push(`%${query.name}%`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = query.limit ?? 50;

    const rows = this.db
      .query<EntityRow, unknown[]>(
        `SELECT * FROM knowledge_entities ${where} ORDER BY mention_count DESC, last_seen DESC LIMIT ?`
      )
      .all(...params, limit);

    return rows.map(rowToEntity);
  }

  // ── Relationships ──────────────────────────────────────────────────

  /**
   * Add or upsert a relationship. If one with the same (source, target, type)
   * exists, it updates strength and metadata. Returns the relationship ID.
   */
  addRelationship(
    fromId: string,
    toId: string,
    type: RelationshipType,
    metadata?: Record<string, unknown>
  ): string {
    const now = Date.now();

    // Try to find existing for dedup
    const existing = this.db
      .query<RelationshipRow, [string, string, string]>(
        "SELECT * FROM knowledge_relationships WHERE source_id = ? AND target_id = ? AND type = ?"
      )
      .get(fromId, toId, type);

    if (existing) {
      // Strengthen existing relationship
      const newStrength = Math.min(1.0, existing.strength + 0.1);
      const updatedMeta = metadata
        ? JSON.stringify({
            ...(existing.metadata ? JSON.parse(existing.metadata) : {}),
            ...metadata,
          })
        : existing.metadata;

      this.db
        .query(
          `UPDATE knowledge_relationships
           SET strength = ?, metadata = COALESCE(?, metadata), updated_at = ?
           WHERE id = ?`
        )
        .run(newStrength, updatedMeta, now, existing.id);

      return existing.id;
    }

    // Insert new
    const id = generateId("rel");
    this.db
      .query(
        `INSERT INTO knowledge_relationships (id, source_id, target_id, type, strength, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0.5, ?, ?, ?)`
      )
      .run(
        id,
        fromId,
        toId,
        type,
        metadata ? JSON.stringify(metadata) : null,
        now,
        now
      );

    return id;
  }

  /**
   * Get all relationships for an entity, optionally filtered by direction.
   */
  getRelationships(
    entityId: string,
    direction: "outgoing" | "incoming" | "both" = "both"
  ): Relationship[] {
    if (direction === "outgoing") {
      return this.db
        .query<RelationshipRow, [string]>(
          "SELECT * FROM knowledge_relationships WHERE source_id = ?"
        )
        .all(entityId)
        .map(rowToRelationship);
    }

    if (direction === "incoming") {
      return this.db
        .query<RelationshipRow, [string]>(
          "SELECT * FROM knowledge_relationships WHERE target_id = ?"
        )
        .all(entityId)
        .map(rowToRelationship);
    }

    // both
    return this.db
      .query<RelationshipRow, [string, string]>(
        "SELECT * FROM knowledge_relationships WHERE source_id = ? OR target_id = ?"
      )
      .all(entityId, entityId)
      .map(rowToRelationship);
  }

  // ── Graph Traversal ────────────────────────────────────────────────

  /**
   * Get the subgraph neighborhood around an entity up to a given depth.
   * Uses BFS. Returns all reachable entities and connecting relationships.
   */
  getSubgraph(entityId: string, depth: number = 1): SubgraphResult {
    const visitedEntities = new Set<string>();
    const collectedRelationships: Relationship[] = [];
    let frontier = [entityId];

    for (let d = 0; d < depth && frontier.length > 0; d++) {
      const nextFrontier: string[] = [];

      for (const nodeId of frontier) {
        if (visitedEntities.has(nodeId)) continue;
        visitedEntities.add(nodeId);

        const rels = this.getRelationships(nodeId, "both");
        for (const rel of rels) {
          // Avoid duplicate relationships in output
          if (!collectedRelationships.some((r) => r.id === rel.id)) {
            collectedRelationships.push(rel);
          }
          // Queue the neighbor for the next depth level
          const neighborId =
            rel.sourceId === nodeId ? rel.targetId : rel.sourceId;
          if (!visitedEntities.has(neighborId)) {
            nextFrontier.push(neighborId);
          }
        }
      }

      frontier = nextFrontier;
    }

    // Also include the last frontier nodes as visited (they're reachable)
    for (const nodeId of frontier) {
      visitedEntities.add(nodeId);
    }

    // Fetch all visited entities
    const entities: Entity[] = [];
    for (const eid of visitedEntities) {
      const entity = this.getEntity(eid);
      if (entity) entities.push(entity);
    }

    return { entities, relationships: collectedRelationships };
  }

  /**
   * Simple pattern matching query. Finds subgraphs where entities match
   * the given type/name pattern and are connected by the given relationship type.
   */
  query(pattern: PatternQuery): SubgraphResult {
    const entities = this.findEntities({
      type: pattern.entityType,
      name: pattern.namePattern,
      limit: pattern.limit ?? 20,
    });

    if (!pattern.relationshipType) {
      return { entities, relationships: [] };
    }

    // Filter to entities that participate in the requested relationship type
    const matchedEntities: Entity[] = [];
    const matchedRelationships: Relationship[] = [];

    for (const entity of entities) {
      const rels = this.getRelationships(entity.id, "both").filter(
        (r) => r.type === pattern.relationshipType
      );
      if (rels.length > 0) {
        matchedEntities.push(entity);
        for (const rel of rels) {
          if (!matchedRelationships.some((r) => r.id === rel.id)) {
            matchedRelationships.push(rel);
          }
        }
      }
    }

    // Also fetch the "other side" entities from the relationships
    const entityIds = new Set(matchedEntities.map((e) => e.id));
    for (const rel of matchedRelationships) {
      for (const targetId of [rel.sourceId, rel.targetId]) {
        if (!entityIds.has(targetId)) {
          entityIds.add(targetId);
          const ent = this.getEntity(targetId);
          if (ent) matchedEntities.push(ent);
        }
      }
    }

    return { entities: matchedEntities, relationships: matchedRelationships };
  }

  // ── Stats ──────────────────────────────────────────────────────────

  getStats(): { entityCount: number; relationshipCount: number; byType: Record<string, number> } {
    const entityCount = (
      this.db
        .query<{ cnt: number }, []>("SELECT COUNT(*) as cnt FROM knowledge_entities")
        .get()
    )?.cnt ?? 0;

    const relationshipCount = (
      this.db
        .query<{ cnt: number }, []>("SELECT COUNT(*) as cnt FROM knowledge_relationships")
        .get()
    )?.cnt ?? 0;

    const typeRows = this.db
      .query<{ type: string; cnt: number }, []>(
        "SELECT type, COUNT(*) as cnt FROM knowledge_entities GROUP BY type"
      )
      .all();

    const byType: Record<string, number> = {};
    for (const row of typeRows) {
      byType[row.type] = row.cnt;
    }

    return { entityCount, relationshipCount, byType };
  }
}
