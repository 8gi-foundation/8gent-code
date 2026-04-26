/**
 * Memory Lint — comprehensive health check composing health, contradictions,
 * and knowledge graph integrity into a single diagnostic report.
 */

import type { Database } from "bun:sqlite";
import { type Contradiction, detectContradictions } from "./contradictions.js";
import type { Entity, KnowledgeGraph, Relationship } from "./graph.js";
import { type MemoryHealth, memoryHealth } from "./health.js";

// ============================================
// Types
// ============================================

export interface OrphanEntity {
	entity: Entity;
	reason: "no_relationships" | "no_mentions";
}

export interface StaleMemory {
	id: string;
	content: string;
	importance: number;
	lastAccessed: number | null;
	daysSinceAccess: number;
}

export interface BrokenReference {
	relationship: Relationship;
	reason: "missing_source" | "missing_target";
}

export interface LintReport {
	timestamp: string;
	health: MemoryHealth;
	orphans: OrphanEntity[];
	contradictions: Contradiction[];
	stale: StaleMemory[];
	broken: BrokenReference[];
	consolidationGaps: number;
	score: number;
}

// ============================================
// Constants
// ============================================

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// ============================================
// lintMemory
// ============================================

export function lintMemory(db: Database, graph: KnowledgeGraph): LintReport {
	const now = Date.now();

	// 1. Base health
	const health = memoryHealth(db);

	// 2. Orphan entities — no relationships AND no mentions in memories
	const orphans: OrphanEntity[] = [];
	const allEntities = graph.findEntities({});
	for (const entity of allEntities) {
		const rels = graph.getRelationships(entity.id, "both");
		if (rels.length > 0) continue;

		const mentionCount =
			(
				db
					.prepare(
						"SELECT COUNT(*) as cnt FROM memories WHERE deleted_at IS NULL AND content_text LIKE '%' || ? || '%'",
					)
					.get(entity.name) as any
			)?.cnt ?? 0;

		if (mentionCount === 0) {
			orphans.push({ entity, reason: "no_relationships" });
		}
	}

	// 3. Contradictions
	const contradictions = detectContradictions(db);

	// 4. Stale memories — low importance AND not accessed in 30 days
	const thirtyDaysAgo = now - THIRTY_DAYS_MS;
	const staleRows = db
		.prepare(
			`SELECT id, content_text, importance, last_accessed
       FROM memories
       WHERE deleted_at IS NULL
         AND importance < 0.3
         AND (last_accessed IS NULL OR last_accessed < ?)
       ORDER BY COALESCE(last_accessed, 0) ASC
       LIMIT 100`,
		)
		.all(thirtyDaysAgo) as Array<{
		id: string;
		content_text: string;
		importance: number;
		last_accessed: number | null;
	}>;

	const stale: StaleMemory[] = staleRows.map((row) => ({
		id: row.id,
		content: row.content_text,
		importance: row.importance,
		lastAccessed: row.last_accessed,
		daysSinceAccess: row.last_accessed
			? Math.floor((now - row.last_accessed) / DAY_MS)
			: Number.POSITIVE_INFINITY,
	}));

	// 5. Broken references — relationships pointing to non-existent entities
	const broken: BrokenReference[] = [];
	const allRels = db
		.prepare("SELECT * FROM knowledge_relationships")
		.all() as Array<{
		id: string;
		source_id: string;
		target_id: string;
		type: string;
		strength: number;
		metadata: string | null;
		created_at: number;
		updated_at: number;
	}>;

	for (const row of allRels) {
		const rel: Relationship = {
			id: row.id,
			sourceId: row.source_id,
			targetId: row.target_id,
			type: row.type as any,
			strength: row.strength,
			metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};

		const sourceExists = graph.getEntity(row.source_id);
		const targetExists = graph.getEntity(row.target_id);

		if (!sourceExists) {
			broken.push({ relationship: rel, reason: "missing_source" });
		}
		if (!targetExists) {
			broken.push({ relationship: rel, reason: "missing_target" });
		}
	}

	// 6. Consolidation gaps — raw memories older than 7 days
	const sevenDaysAgo = now - SEVEN_DAYS_MS;
	const consolidationGaps =
		(
			db
				.prepare(
					`SELECT COUNT(*) as cnt FROM memories
         WHERE deleted_at IS NULL
           AND consolidation_level = 'raw'
           AND created_at < ?`,
				)
				.get(sevenDaysAgo) as any
		)?.cnt ?? 0;

	// 7. Composite score
	let score = health.healthScore;
	score -= Math.min(20, orphans.length * 2);
	score -= Math.min(25, contradictions.length * 5);
	score -= Math.min(15, Math.floor(stale.length / 10));
	score -= Math.min(20, broken.length * 10);
	if (consolidationGaps > 50) score -= 5;
	score = Math.max(0, Math.min(100, score));

	return {
		timestamp: new Date(now).toISOString(),
		health,
		orphans,
		contradictions,
		stale,
		broken,
		consolidationGaps,
		score,
	};
}

// ============================================
// lintReportToMarkdown
// ============================================

export function lintReportToMarkdown(report: LintReport): string {
	const lines: string[] = [];

	lines.push("# Memory Lint Report");
	lines.push(`Generated: ${report.timestamp}`);
	lines.push("");
	lines.push(`## Health Score: ${report.score}/100`);
	lines.push("");

	lines.push("## Summary");
	lines.push("| Metric | Value |");
	lines.push("|--------|-------|");
	lines.push(`| Total Memories | ${report.health.totalCount} |`);
	lines.push(`| Orphan Entities | ${report.orphans.length} |`);
	lines.push(`| Contradictions | ${report.contradictions.length} |`);
	lines.push(`| Stale Memories | ${report.stale.length} |`);
	lines.push(`| Broken References | ${report.broken.length} |`);
	lines.push(`| Consolidation Gaps | ${report.consolidationGaps} |`);
	lines.push("");

	if (report.orphans.length > 0) {
		lines.push("## Orphan Entities");
		for (const o of report.orphans) {
			lines.push(`- **${o.entity.name}** (${o.entity.type}) — ${o.reason}`);
		}
		lines.push("");
	}

	if (report.contradictions.length > 0) {
		lines.push("## Contradictions");
		for (const c of report.contradictions) {
			const snipA = c.memoryA.content.slice(0, 80);
			const snipB = c.memoryB.content.slice(0, 80);
			lines.push(
				`- [${c.conflictType}] "${snipA}" vs "${snipB}" (confidence: ${c.confidence.toFixed(2)})`,
			);
		}
		lines.push("");
	}

	if (report.stale.length > 0) {
		lines.push("## Stale Memories");
		const top10 = report.stale.slice(0, 10);
		for (const s of top10) {
			const days =
				s.daysSinceAccess === Number.POSITIVE_INFINITY
					? "never accessed"
					: `${s.daysSinceAccess}d ago`;
			lines.push(
				`- \`${s.id}\` importance=${s.importance.toFixed(2)} last=${days} — ${s.content.slice(0, 60)}`,
			);
		}
		lines.push("");
	}

	if (report.broken.length > 0) {
		lines.push("## Broken References");
		for (const b of report.broken) {
			lines.push(
				`- Relationship \`${b.relationship.id}\`: ${b.reason} (source=${b.relationship.sourceId}, target=${b.relationship.targetId})`,
			);
		}
		lines.push("");
	}

	return lines.join("\n");
}
