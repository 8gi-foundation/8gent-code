/**
 * Wiki Generator — transforms knowledge graph entities and consolidated
 * memories into navigable, interlinked markdown pages.
 *
 * Each entity becomes a page with frontmatter, related-entity links,
 * memory excerpts, and backlinks. An index groups pages by entity type
 * and a log page summarises consolidation activity.
 */

import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Entity, EntityType, KnowledgeGraph, Relationship } from "./graph.js";

// ── Public Types ─────────────────────────────────────────────────────

export interface WikiPage {
	slug: string;
	title: string;
	entityId: string;
	entityType: EntityType;
	frontmatter: Record<string, unknown>;
	markdown: string;
}

export interface WikiIndex {
	pages: Array<{ slug: string; title: string; type: string; summary: string }>;
	markdown: string;
}

export interface WikiLog {
	entries: Array<{ timestamp: string; action: string; detail: string }>;
	markdown: string;
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Lowercase, replace non-alphanumeric with hyphens, collapse multiples. */
export function slugify(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-");
}

function isoFromUnix(ms: number): string {
	return new Date(ms).toISOString();
}

function yamlFrontmatter(fields: Record<string, unknown>): string {
	const lines = ["---"];
	for (const [key, value] of Object.entries(fields)) {
		if (value === undefined || value === null) continue;
		lines.push(`${key}: ${JSON.stringify(value)}`);
	}
	lines.push("---");
	return lines.join("\n");
}

// ── Row type for direct SQL queries on memories table ────────────────

interface MemoryRow {
	content_text: string;
	importance: number;
	created_at: number;
}

interface ConsolidationRow {
	id: string;
	level: string;
	status: string;
	created_at: number;
	completed_at: number | null;
}

interface CountRow {
	type: string;
	cnt: number;
}

// ── WikiGenerator ────────────────────────────────────────────────────

export class WikiGenerator {
	constructor(
		private db: Database,
		private graph: KnowledgeGraph,
	) {}

	// ── Single entity page ─────────────────────────────────────────────

	generateEntityPage(entityId: string): WikiPage | null {
		const entity = this.graph.getEntity(entityId);
		if (!entity) return null;

		const slug = slugify(entity.name);
		const outgoing = this.graph.getRelationships(entityId, "outgoing");
		const incoming = this.graph.getRelationships(entityId, "incoming");

		// Fetch memories mentioning this entity (latest 10, ordered by importance)
		const memories = this.queryMemories(entity.name);

		// Average importance from related memories (fallback 0.5)
		const avgImportance =
			memories.length > 0
				? memories.reduce((sum, m) => sum + m.importance, 0) / memories.length
				: 0.5;

		// Build frontmatter
		const frontmatter: Record<string, unknown> = {
			type: entity.type,
			name: entity.name,
			mentionCount: entity.mentionCount,
			firstSeen: isoFromUnix(entity.firstSeen),
			lastSeen: isoFromUnix(entity.lastSeen),
			importance: Math.round(avgImportance * 1000) / 1000,
		};

		const sections: string[] = [];
		sections.push(yamlFrontmatter(frontmatter));
		sections.push("");
		sections.push(`# ${entity.name}`);
		sections.push("");
		sections.push(`**Type:** ${entity.type}`);
		if (entity.description) {
			sections.push(`\n${entity.description}`);
		}

		// Related entities (outgoing)
		if (outgoing.length > 0) {
			sections.push("");
			sections.push("## Related Entities");
			sections.push("");
			const grouped = this.groupRelationships(outgoing, "target");
			for (const [relType, entities] of Object.entries(grouped)) {
				sections.push(`### ${relType}`);
				for (const e of entities) {
					sections.push(`- [${e.name}](${slugify(e.name)}.md)`);
				}
				sections.push("");
			}
		}

		// Memories
		if (memories.length > 0) {
			sections.push("## Memories");
			sections.push("");
			for (const mem of memories) {
				const snippet =
					mem.content_text.length > 200 ? `${mem.content_text.slice(0, 200)}...` : mem.content_text;
				sections.push(`- ${snippet}`);
			}
			sections.push("");
		}

		// Backlinks (incoming)
		if (incoming.length > 0) {
			sections.push("## Backlinks");
			sections.push("");
			const grouped = this.groupRelationships(incoming, "source");
			for (const [relType, entities] of Object.entries(grouped)) {
				sections.push(`### ${relType}`);
				for (const e of entities) {
					sections.push(`- [${e.name}](${slugify(e.name)}.md)`);
				}
				sections.push("");
			}
		}

		return {
			slug,
			title: entity.name,
			entityId,
			entityType: entity.type,
			frontmatter,
			markdown: sections.join("\n"),
		};
	}

	// ── All pages ──────────────────────────────────────────────────────

	generateAllPages(): WikiPage[] {
		const entities = this.graph.findEntities({});
		const pages: WikiPage[] = [];
		for (const entity of entities) {
			const page = this.generateEntityPage(entity.id);
			if (page) pages.push(page);
		}
		return pages;
	}

	// ── Index ──────────────────────────────────────────────────────────

	generateIndex(): WikiIndex {
		const entities = this.graph.findEntities({});
		const byType = new Map<string, Entity[]>();

		for (const entity of entities) {
			const list = byType.get(entity.type) ?? [];
			list.push(entity);
			byType.set(entity.type, list);
		}

		const pageList: WikiIndex["pages"] = [];
		const sections: string[] = ["# Wiki Index", ""];

		for (const [type, group] of [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
			sections.push(`## ${type}`);
			sections.push("");
			for (const entity of group) {
				const slug = slugify(entity.name);
				const summary = entity.description ?? this.firstMemorySnippet(entity.name);
				sections.push(`- [${entity.name}](${slug}.md) -- ${summary}`);
				pageList.push({ slug, title: entity.name, type, summary });
			}
			sections.push("");
		}

		return {
			pages: pageList,
			markdown: sections.join("\n"),
		};
	}

	// ── Log ────────────────────────────────────────────────────────────

	generateLog(): WikiLog {
		const entries: WikiLog["entries"] = [];
		const sections: string[] = ["# Wiki Log", ""];

		// Memory counts by type
		try {
			const typeRows = this.db
				.query<CountRow, []>(
					"SELECT type, COUNT(*) as cnt FROM memories WHERE deleted_at IS NULL GROUP BY type",
				)
				.all();

			if (typeRows.length > 0) {
				sections.push("## Memory Counts");
				sections.push("");
				for (const row of typeRows) {
					sections.push(`- **${row.type}**: ${row.cnt}`);
				}
				sections.push("");
			}
		} catch {
			// memories table may not exist in some test setups
		}

		// Consolidation log entries
		try {
			const logRows = this.db
				.query<ConsolidationRow, []>(
					"SELECT id, level, status, created_at, completed_at FROM consolidation_log ORDER BY created_at DESC LIMIT 50",
				)
				.all();

			if (logRows.length > 0) {
				sections.push("## Consolidation Log");
				sections.push("");
				for (const row of logRows) {
					const ts = isoFromUnix(row.created_at);
					const detail = `level=${row.level} status=${row.status}`;
					entries.push({ timestamp: ts, action: "consolidation", detail });
					sections.push(`- **${ts}** -- ${detail}`);
				}
				sections.push("");
			}
		} catch {
			// consolidation_log table may not exist
		}

		return { entries, markdown: sections.join("\n") };
	}

	// ── Write to disk ──────────────────────────────────────────────────

	writeToDirectory(outputDir: string): {
		pagesWritten: number;
		indexWritten: boolean;
	} {
		mkdirSync(outputDir, { recursive: true });

		const pages = this.generateAllPages();
		for (const page of pages) {
			writeFileSync(join(outputDir, `${page.slug}.md`), page.markdown, "utf-8");
		}

		const index = this.generateIndex();
		writeFileSync(join(outputDir, "index.md"), index.markdown, "utf-8");

		const log = this.generateLog();
		writeFileSync(join(outputDir, "log.md"), log.markdown, "utf-8");

		return { pagesWritten: pages.length, indexWritten: true };
	}

	// ── Private helpers ────────────────────────────────────────────────

	private queryMemories(entityName: string): MemoryRow[] {
		try {
			return this.db
				.query<MemoryRow, [string]>(
					`SELECT content_text, importance, created_at
           FROM memories
           WHERE content_text LIKE ? AND deleted_at IS NULL
           ORDER BY importance DESC, created_at DESC
           LIMIT 10`,
				)
				.all(`%${entityName}%`);
		} catch {
			return [];
		}
	}

	private firstMemorySnippet(entityName: string): string {
		const rows = this.queryMemories(entityName);
		if (rows.length === 0) return "(no description)";
		const text = rows[0].content_text;
		return text.length > 80 ? `${text.slice(0, 80)}...` : text;
	}

	private groupRelationships(
		rels: Relationship[],
		side: "source" | "target",
	): Record<string, Entity[]> {
		const grouped: Record<string, Entity[]> = {};
		for (const rel of rels) {
			const otherId = side === "target" ? rel.targetId : rel.sourceId;
			const other = this.graph.getEntity(otherId);
			if (!other) continue;
			const list = grouped[rel.type] ?? [];
			list.push(other);
			grouped[rel.type] = list;
		}
		return grouped;
	}
}
