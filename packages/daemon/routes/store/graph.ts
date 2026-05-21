/**
 * graph.* JSON-RPC handlers - the canonical entity/relationship graph over
 * the daemon `/store` surface.
 *
 * This route exposes `KnowledgeGraph` (packages/memory/graph.ts): the real,
 * deduplicated entity + relationship store. It is distinct from the `kg.*`
 * route, which is a flat file-chunk store over `MemoryStore`. The two share
 * the same on-disk SQLite file (`~/.8gent/memory/memory.db`) but operate on
 * different tables: `kg.*` touches `memories`, `graph.*` touches
 * `knowledge_entities` / `knowledge_relationships`.
 *
 * Every method is project-scoped via a `projectId` param (default 'default'),
 * so a desktop client can read and write a per-project canonical graph.
 *
 * Auth: these handlers live on the same `/store` route as `kg.*`, so the
 * capability-token handshake gates them automatically. There is no separate
 * auth path here.
 */

import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	DEFAULT_PROJECT_ID,
	type EntityType,
	KnowledgeGraph,
	type RelationshipType,
} from "../../../memory/graph";
import { JSONRPC_INVALID_PARAMS, JsonRpcError, type JsonRpcHandler } from "./jsonrpc";

// ── Graph store (one KnowledgeGraph over the shared memory DB) ─────────

let _db: Database | null = null;
let _graph: KnowledgeGraph | null = null;
let _dbPath: string | null = null;

function defaultDbPath(): string {
	const dir = path.join(
		process.env.EIGHT_DATA_DIR || path.join(os.homedir(), ".8gent"),
		"memory",
	);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	return path.join(dir, "memory.db");
}

function graph(): KnowledgeGraph {
	if (_graph) return _graph;
	const dbPath = _dbPath ?? defaultDbPath();
	_db = new Database(dbPath);
	_graph = new KnowledgeGraph(_db);
	return _graph;
}

/** Test hook: rebind the graph to a fresh on-disk DB. */
export function _setGraphStorePath(dbPath: string | null): void {
	if (_db) {
		try {
			_db.close();
		} catch {}
	}
	_db = null;
	_graph = null;
	_dbPath = dbPath;
}

// ── Param validation ──────────────────────────────────────────────────

function invalid(message: string): never {
	throw new JsonRpcError(JSONRPC_INVALID_PARAMS, message);
}

function asObject(raw: unknown): Record<string, unknown> {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		invalid("params must be an object");
	}
	return raw as Record<string, unknown>;
}

function requireString(obj: Record<string, unknown>, key: string, method: string): string {
	const value = obj[key];
	if (typeof value !== "string" || value.length === 0) {
		invalid(`${method}: missing or invalid '${key}' (expected non-empty string)`);
	}
	return value as string;
}

function optionalString(obj: Record<string, unknown>, key: string, method: string): string | undefined {
	const value = obj[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") invalid(`${method}: '${key}' must be a string`);
	return value as string;
}

function optionalNumber(obj: Record<string, unknown>, key: string, method: string): number | undefined {
	const value = obj[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		invalid(`${method}: '${key}' must be a finite number`);
	}
	return value as number;
}

function optionalRecord(
	obj: Record<string, unknown>,
	key: string,
	method: string,
): Record<string, unknown> | undefined {
	const value = obj[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "object" || Array.isArray(value)) {
		invalid(`${method}: '${key}' must be an object`);
	}
	return value as Record<string, unknown>;
}

/** Resolve the projectId param, defaulting to 'default'. */
function resolveProjectId(obj: Record<string, unknown>, method: string): string {
	const pid = optionalString(obj, "projectId", method);
	return pid ?? DEFAULT_PROJECT_ID;
}

// ── Handlers ──────────────────────────────────────────────────────────

/**
 * graph.upsertEntity - upsert one entity into the project's canonical graph.
 * params:  { projectId?, type, name, summary?, metadata? }
 * returns: the entity row { id, projectId, type, name, mentionCount, ... }
 */
export const graphUpsertEntity: JsonRpcHandler = (raw) => {
	const obj = asObject(raw);
	const method = "graph.upsertEntity";
	const projectId = resolveProjectId(obj, method);
	const type = requireString(obj, "type", method) as EntityType;
	const name = requireString(obj, "name", method);
	// `summary` is the wire name; the store field is `description`.
	const summary = optionalString(obj, "summary", method);
	const metadata = optionalRecord(obj, "metadata", method);

	const g = graph();
	const id = g.addEntity(
		type,
		name,
		{ description: summary, metadata },
		projectId,
	);
	const entity = g.getEntity(id);
	if (!entity) {
		throw new JsonRpcError(JSONRPC_INVALID_PARAMS, `${method}: entity vanished after upsert`);
	}
	return { entity };
};

/**
 * graph.upsertRelationship - upsert one relationship.
 * params:  { projectId?, sourceId, targetId, type, weight? }
 * returns: the relationship row { id, projectId, sourceId, targetId, type, strength, ... }
 *
 * Note: `weight` is accepted for forward compatibility with the desktop
 * client wire shape. KnowledgeGraph.addRelationship manages `strength`
 * itself (0.5 on insert, +0.1 reinforcement on upsert); an explicit weight,
 * when given, is recorded under metadata.weight rather than overriding the
 * store's reinforcement model.
 */
export const graphUpsertRelationship: JsonRpcHandler = (raw) => {
	const obj = asObject(raw);
	const method = "graph.upsertRelationship";
	const projectId = resolveProjectId(obj, method);
	const sourceId = requireString(obj, "sourceId", method);
	const targetId = requireString(obj, "targetId", method);
	const type = requireString(obj, "type", method) as RelationshipType;
	const weight = optionalNumber(obj, "weight", method);

	const g = graph();
	const metadata = weight === undefined ? undefined : { weight };
	const id = g.addRelationship(sourceId, targetId, type, metadata, projectId);
	const all = g.getRelationships(sourceId, "outgoing");
	const relationship = all.find((r) => r.id === id) ?? null;
	if (!relationship) {
		throw new JsonRpcError(
			JSONRPC_INVALID_PARAMS,
			`${method}: relationship not found after upsert (check sourceId/targetId exist)`,
		);
	}
	return { relationship };
};

/**
 * graph.query - return the project's graph, optionally filtered by pattern.
 * params:  { projectId?, pattern? }
 * returns: { entities: Entity[], relationships: Relationship[] }
 *
 * With no `pattern`, returns the full project graph (all entities and all
 * relationships for that projectId). With a `pattern` it delegates to
 * KnowledgeGraph.query, which supports { entityType?, relationshipType?,
 * namePattern?, limit? }.
 */
export const graphQuery: JsonRpcHandler = (raw) => {
	const obj = asObject(raw);
	const method = "graph.query";
	const projectId = resolveProjectId(obj, method);
	const pattern = optionalRecord(obj, "pattern", method);

	const g = graph();

	if (!pattern) {
		// Full project graph. findEntities is project-scoped; a high limit is
		// used so the desktop renderer gets the complete picture.
		const entities = g.findEntities({ projectId, limit: 100_000 });
		const entityIds = new Set(entities.map((e) => e.id));
		const relationships = [];
		const seen = new Set<string>();
		for (const e of entities) {
			for (const rel of g.getRelationships(e.id, "both")) {
				// Keep only edges fully inside this project's entity set, and
				// deduplicate (getRelationships(both) returns each edge twice
				// once per endpoint).
				if (seen.has(rel.id)) continue;
				if (!entityIds.has(rel.sourceId) || !entityIds.has(rel.targetId)) continue;
				seen.add(rel.id);
				relationships.push(rel);
			}
		}
		return { entities, relationships };
	}

	// Pattern-filtered query. KnowledgeGraph.query already returns a coherent
	// { entities, relationships } subgraph.
	const result = g.query(pattern as Parameters<KnowledgeGraph["query"]>[0], projectId);
	return { entities: result.entities, relationships: result.relationships };
};

/**
 * graph.subgraph - the neighbourhood around one entity.
 * params:  { projectId?, entityId, depth? }
 * returns: { entities: Entity[], relationships: Relationship[] }
 */
export const graphSubgraph: JsonRpcHandler = (raw) => {
	const obj = asObject(raw);
	const method = "graph.subgraph";
	const projectId = resolveProjectId(obj, method);
	const entityId = requireString(obj, "entityId", method);
	const depthRaw = optionalNumber(obj, "depth", method);
	const depth = depthRaw === undefined ? 1 : Math.max(1, Math.min(10, Math.floor(depthRaw)));

	const g = graph();
	const result = g.getSubgraph(entityId, depth, projectId);
	return { entities: result.entities, relationships: result.relationships };
};

/**
 * graph.stats - entity/relationship counts for a project.
 * params:  { projectId? }
 * returns: { entityCount, relationshipCount, byType }
 */
export const graphStats: JsonRpcHandler = (raw) => {
	const obj = asObject(raw);
	const method = "graph.stats";
	const projectId = resolveProjectId(obj, method);
	return graph().getStats(projectId);
};
