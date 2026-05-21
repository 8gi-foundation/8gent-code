/**
 * Knowledge Graph - Entity and Relationship store backed by SQLite.
 *
 * Tables live alongside the memory store in the same .8gent/memory/ database.
 * The graph is partitioned by `project_id`: each project owns its own
 * canonical graph. Within a project:
 *   - Entities are deduplicated by (project_id, type, name).
 *   - Relationships are deduplicated by (project_id, source_id, target_id, type).
 * This keeps the information-theoretic invariant (one entity per identity)
 * per project, while letting the same identity exist independently across
 * projects. Callers that pass no projectId land in the `'default'` project,
 * which is what preserves backwards compatibility for existing in-process
 * callers in packages/memory/.
 *
 * All single-entity lookups target <10ms via indexed queries.
 */

import type { Database } from "bun:sqlite";
import * as crypto from "node:crypto";

// ============================================
// Types
// ============================================

export type EntityType =
	| "file"
	| "function"
	| "package"
	| "person"
	| "session"
	| "decision"
	| "concept"
	| "preference"
	| "tool"
	| "video" // VIDEO-INGESTION spec 9.4: a source video, keyed by videoId
	| "event"; // VIDEO-INGESTION spec 9.4: a timestamped moment within a video

export type RelationshipType =
	| "depends_on"
	| "implements"
	| "authored_by"
	| "decided"
	| "prefers"
	| "uses"
	| "contains"
	| "related_to"
	| "occurs_in" // VIDEO-INGESTION spec 9.4: event occurs_in video
	| "precedes" // VIDEO-INGESTION spec 9.4: event precedes event (temporal order)
	| "mentions"; // VIDEO-INGESTION spec 9.4: event/transcript mentions concept/person

/** Default project partition for callers that do not scope explicitly. */
export const DEFAULT_PROJECT_ID = "default";

export interface Entity {
	id: string;
	projectId: string;
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
	projectId: string;
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
	project_id: string;
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
	project_id: string;
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
		projectId: row.project_id,
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
		projectId: row.project_id,
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
		// Migrate first: a DB created before project scoping has the old
		// table-level UNIQUE(type, name) / UNIQUE(source_id, target_id, type)
		// constraints, which would block legitimate cross-project writes of
		// the same identity. SQLite has no ALTER ... DROP CONSTRAINT, so the
		// legacy tables are rebuilt. Migration runs before CREATE TABLE IF
		// NOT EXISTS so the fresh-DB path is untouched by it.
		this.migrateAddProjectId();

		// Fresh-DB shape. `project_id` partitions the graph; the table-level
		// UNIQUE constraints are per-project so the dedup invariant (one
		// entity per identity) holds within a project, not across the DB.
		this.db.run(`
      CREATE TABLE IF NOT EXISTS knowledge_entities (
        id            TEXT PRIMARY KEY,
        project_id    TEXT NOT NULL DEFAULT 'default',
        type          TEXT NOT NULL,
        name          TEXT NOT NULL,
        description   TEXT,
        metadata      TEXT,
        first_seen    INTEGER NOT NULL,
        last_seen     INTEGER NOT NULL,
        mention_count INTEGER NOT NULL DEFAULT 1,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        UNIQUE(project_id, type, name)
      )
    `);

		this.db.run(`
      CREATE TABLE IF NOT EXISTS knowledge_relationships (
        id            TEXT PRIMARY KEY,
        project_id    TEXT NOT NULL DEFAULT 'default',
        source_id     TEXT NOT NULL REFERENCES knowledge_entities(id),
        target_id     TEXT NOT NULL REFERENCES knowledge_entities(id),
        type          TEXT NOT NULL,
        strength      REAL NOT NULL DEFAULT 0.5,
        metadata      TEXT,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        UNIQUE(project_id, source_id, target_id, type)
      )
    `);

		this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_ke_type ON knowledge_entities(type)
    `);
		this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_ke_name ON knowledge_entities(name)
    `);
		this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_ke_project ON knowledge_entities(project_id)
    `);
		this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_ke_project_type_name
        ON knowledge_entities(project_id, type, name)
    `);
		// Per-project uniqueness as an index. On a fresh DB this duplicates the
		// table-level UNIQUE; on a migrated DB it is the enforcement point for
		// the new (project_id, type, name) identity.
		this.db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_ke_project_type_name
        ON knowledge_entities(project_id, type, name)
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
		this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_kr_project ON knowledge_relationships(project_id)
    `);
		this.db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_kr_project_edge
        ON knowledge_relationships(project_id, source_id, target_id, type)
    `);
	}

	/**
	 * Migrate a DB created before project scoping existed.
	 *
	 * A pre-scoping table has no `project_id` column and carries the old
	 * table-level UNIQUE(type, name) / UNIQUE(source_id, target_id, type)
	 * constraint. Simply adding the column with ALTER TABLE would leave that
	 * legacy constraint in place, which would wrongly block writing the same
	 * identity into a second project. SQLite has no ALTER ... DROP CONSTRAINT,
	 * so the only correct fix is a table rebuild: create the new-shape table,
	 * copy every row across with project_id backfilled to 'default', drop the
	 * old table, rename the new one into place.
	 *
	 * Safe on a populated DB (all rows are copied) and idempotent: it only
	 * acts when the table exists AND lacks the project_id column. On a fresh
	 * DB the tables do not exist yet, so this is a no-op and the CREATE TABLE
	 * statements in initSchema build the new shape directly.
	 */
	private migrateAddProjectId(): void {
		this.migrateTable(
			"knowledge_entities",
			`CREATE TABLE knowledge_entities (
				id            TEXT PRIMARY KEY,
				project_id    TEXT NOT NULL DEFAULT 'default',
				type          TEXT NOT NULL,
				name          TEXT NOT NULL,
				description   TEXT,
				metadata      TEXT,
				first_seen    INTEGER NOT NULL,
				last_seen     INTEGER NOT NULL,
				mention_count INTEGER NOT NULL DEFAULT 1,
				created_at    INTEGER NOT NULL,
				updated_at    INTEGER NOT NULL,
				UNIQUE(project_id, type, name)
			)`,
			`INSERT INTO knowledge_entities
				(id, project_id, type, name, description, metadata,
				 first_seen, last_seen, mention_count, created_at, updated_at)
			 SELECT id, 'default', type, name, description, metadata,
				 first_seen, last_seen, mention_count, created_at, updated_at
			 FROM knowledge_entities_legacy`,
		);

		this.migrateTable(
			"knowledge_relationships",
			`CREATE TABLE knowledge_relationships (
				id            TEXT PRIMARY KEY,
				project_id    TEXT NOT NULL DEFAULT 'default',
				source_id     TEXT NOT NULL REFERENCES knowledge_entities(id),
				target_id     TEXT NOT NULL REFERENCES knowledge_entities(id),
				type          TEXT NOT NULL,
				strength      REAL NOT NULL DEFAULT 0.5,
				metadata      TEXT,
				created_at    INTEGER NOT NULL,
				updated_at    INTEGER NOT NULL,
				UNIQUE(project_id, source_id, target_id, type)
			)`,
			`INSERT INTO knowledge_relationships
				(id, project_id, source_id, target_id, type, strength, metadata, created_at, updated_at)
			 SELECT id, 'default', source_id, target_id, type, strength, metadata, created_at, updated_at
			 FROM knowledge_relationships_legacy`,
		);
	}

	/**
	 * Rebuild one legacy table in place. No-op unless the table exists and is
	 * missing `project_id`. Wrapped in a transaction so a populated DB is
	 * never left half-migrated.
	 */
	private migrateTable(table: string, createSql: string, copySql: string): void {
		const exists =
			this.db
				.query<{ cnt: number }, [string]>(
					"SELECT COUNT(*) as cnt FROM sqlite_master WHERE type = 'table' AND name = ?",
				)
				.get(table)?.cnt ?? 0;
		if (exists === 0) return; // Fresh DB: nothing to migrate.

		const cols = this.db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
		if (cols.some((c) => c.name === "project_id")) return; // Already migrated.

		this.db.transaction(() => {
			this.db.run(`ALTER TABLE ${table} RENAME TO ${table}_legacy`);
			this.db.run(createSql);
			this.db.run(copySql);
			this.db.run(`DROP TABLE ${table}_legacy`);
		})();
	}

	// ── Entities ───────────────────────────────────────────────────────

	/**
	 * Add or upsert an entity within a project. If an entity with the same
	 * (projectId, type, name) exists, it increments mention_count and updates
	 * last_seen + metadata. Returns the entity ID (existing or new).
	 *
	 * `projectId` is the trailing argument and defaults to 'default' so
	 * existing positional callers keep working unchanged.
	 */
	addEntity(
		type: EntityType,
		name: string,
		properties?: { description?: string; metadata?: Record<string, unknown> },
		projectId: string = DEFAULT_PROJECT_ID,
	): string {
		const now = Date.now();
		const id = generateId("ent");
		const metaJson = properties?.metadata ? JSON.stringify(properties.metadata) : null;

		// Atomic upsert via ON CONFLICT -- race-condition-safe. The conflict
		// target is the per-project (project_id, type, name) unique index, so
		// dedup is scoped to the project.
		this.db
			.query(
				`INSERT INTO knowledge_entities
           (id, project_id, type, name, description, metadata, first_seen, last_seen, mention_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(project_id, type, name) DO UPDATE SET
           mention_count = knowledge_entities.mention_count + 1,
           last_seen     = excluded.last_seen,
           description   = COALESCE(excluded.description, knowledge_entities.description),
           metadata      = CASE
                             WHEN excluded.metadata IS NOT NULL AND knowledge_entities.metadata IS NOT NULL
                               THEN json_patch(knowledge_entities.metadata, excluded.metadata)
                             WHEN excluded.metadata IS NOT NULL
                               THEN excluded.metadata
                             ELSE knowledge_entities.metadata
                           END,
           updated_at    = excluded.updated_at`,
			)
			.run(id, projectId, type, name, properties?.description ?? null, metaJson, now, now, now, now);

		// Return the actual row ID (may differ from `id` on conflict).
		// Row is guaranteed to exist because we just INSERTed (or updated on conflict).
		const row = this.db
			.query<{ id: string }, [string, string, string]>(
				"SELECT id FROM knowledge_entities WHERE project_id = ? AND type = ? AND name = ?",
			)
			.get(projectId, type, name);

		return row?.id ?? id;
	}

	/**
	 * Get a single entity by ID.
	 */
	getEntity(id: string): Entity | null {
		const row = this.db
			.query<EntityRow, [string]>("SELECT * FROM knowledge_entities WHERE id = ?")
			.get(id);

		return row ? rowToEntity(row) : null;
	}

	/**
	 * Find entities matching a query. Supports type filter, name substring,
	 * and result limit. Scoped to a single project (default 'default').
	 */
	findEntities(query: {
		type?: EntityType;
		name?: string;
		limit?: number;
		projectId?: string;
	}): Entity[] {
		const conditions: string[] = ["project_id = ?"];
		const params: unknown[] = [query.projectId ?? DEFAULT_PROJECT_ID];

		if (query.type) {
			conditions.push("type = ?");
			params.push(query.type);
		}

		if (query.name) {
			conditions.push("name LIKE ?");
			params.push(`%${query.name}%`);
		}

		const where = `WHERE ${conditions.join(" AND ")}`;
		const limit = query.limit ?? 50;

		const rows = this.db
			.query<EntityRow, import("bun:sqlite").SQLQueryBindings[]>(
				`SELECT * FROM knowledge_entities ${where} ORDER BY mention_count DESC, last_seen DESC LIMIT ?`,
			)
			.all(...(params as import("bun:sqlite").SQLQueryBindings[]), limit);

		return rows.map(rowToEntity);
	}

	// ── Relationships ──────────────────────────────────────────────────

	/**
	 * Add or upsert a relationship within a project. If one with the same
	 * (projectId, source, target, type) exists, it updates strength and
	 * metadata. Returns the relationship ID.
	 *
	 * `projectId` is the trailing argument and defaults to 'default' so
	 * existing positional callers keep working unchanged.
	 */
	addRelationship(
		fromId: string,
		toId: string,
		type: RelationshipType,
		metadata?: Record<string, unknown>,
		projectId: string = DEFAULT_PROJECT_ID,
	): string {
		const now = Date.now();

		// Try to find existing for dedup, scoped to the project.
		const existing = this.db
			.query<RelationshipRow, [string, string, string, string]>(
				"SELECT * FROM knowledge_relationships WHERE project_id = ? AND source_id = ? AND target_id = ? AND type = ?",
			)
			.get(projectId, fromId, toId, type);

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
           WHERE id = ?`,
				)
				.run(newStrength, updatedMeta, now, existing.id);

			return existing.id;
		}

		// Insert new
		const id = generateId("rel");
		this.db
			.query(
				`INSERT INTO knowledge_relationships (id, project_id, source_id, target_id, type, strength, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0.5, ?, ?, ?)`,
			)
			.run(id, projectId, fromId, toId, type, metadata ? JSON.stringify(metadata) : null, now, now);

		return id;
	}

	/**
	 * Get all relationships for an entity, optionally filtered by direction.
	 */
	getRelationships(
		entityId: string,
		direction: "outgoing" | "incoming" | "both" = "both",
	): Relationship[] {
		if (direction === "outgoing") {
			return this.db
				.query<RelationshipRow, [string]>(
					"SELECT * FROM knowledge_relationships WHERE source_id = ?",
				)
				.all(entityId)
				.map(rowToRelationship);
		}

		if (direction === "incoming") {
			return this.db
				.query<RelationshipRow, [string]>(
					"SELECT * FROM knowledge_relationships WHERE target_id = ?",
				)
				.all(entityId)
				.map(rowToRelationship);
		}

		// both
		return this.db
			.query<RelationshipRow, [string, string]>(
				"SELECT * FROM knowledge_relationships WHERE source_id = ? OR target_id = ?",
			)
			.all(entityId, entityId)
			.map(rowToRelationship);
	}

	// ── Graph Traversal ────────────────────────────────────────────────

	/**
	 * Get the subgraph neighborhood around an entity up to a given depth.
	 * Uses BFS. Returns all reachable entities and connecting relationships.
	 *
	 * Traversal is intrinsically project-scoped: entity IDs are globally
	 * unique and every relationship row carries the project of its endpoints,
	 * so BFS from an entity never crosses into another project's graph. The
	 * `projectId` parameter is accepted for call-site symmetry with the other
	 * project-scoped methods and is otherwise advisory.
	 */
	getSubgraph(entityId: string, depth = 1, _projectId: string = DEFAULT_PROJECT_ID): SubgraphResult {
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
					const neighborId = rel.sourceId === nodeId ? rel.targetId : rel.sourceId;
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
	 * the given type/name pattern and are connected by the given relationship
	 * type. Scoped to a single project (default 'default').
	 */
	query(pattern: PatternQuery, projectId: string = DEFAULT_PROJECT_ID): SubgraphResult {
		const entities = this.findEntities({
			type: pattern.entityType,
			name: pattern.namePattern,
			limit: pattern.limit ?? 20,
			projectId,
		});

		if (!pattern.relationshipType) {
			return { entities, relationships: [] };
		}

		// Filter to entities that participate in the requested relationship type
		const matchedEntities: Entity[] = [];
		const matchedRelationships: Relationship[] = [];

		for (const entity of entities) {
			const rels = this.getRelationships(entity.id, "both").filter(
				(r) => r.type === pattern.relationshipType,
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

	getStats(projectId: string = DEFAULT_PROJECT_ID): {
		entityCount: number;
		relationshipCount: number;
		byType: Record<string, number>;
	} {
		const entityCount =
			this.db
				.query<{ cnt: number }, [string]>(
					"SELECT COUNT(*) as cnt FROM knowledge_entities WHERE project_id = ?",
				)
				.get(projectId)?.cnt ?? 0;

		const relationshipCount =
			this.db
				.query<{ cnt: number }, [string]>(
					"SELECT COUNT(*) as cnt FROM knowledge_relationships WHERE project_id = ?",
				)
				.get(projectId)?.cnt ?? 0;

		const typeRows = this.db
			.query<{ type: string; cnt: number }, [string]>(
				"SELECT type, COUNT(*) as cnt FROM knowledge_entities WHERE project_id = ? GROUP BY type",
			)
			.all(projectId);

		const byType: Record<string, number> = {};
		for (const row of typeRows) {
			byType[row.type] = row.cnt;
		}

		return { entityCount, relationshipCount, byType };
	}
}
