/**
 * ConceptLinker — Auto-links memory entities to concept entities by
 * matching concept names in content text using word-boundary regex.
 *
 * Usage:
 *   const linker = new ConceptLinker(graph);
 *   const linkedIds = linker.linkMemoryToConcepts(memoryId, contentText);
 *
 * Matching rules:
 *   - Word-boundary regex (concept "auth" won't match "authentication")
 *   - Case-insensitive
 *   - Special regex chars in concept names are escaped
 *   - Adaptive boundaries for names starting/ending with non-word chars
 *   - Deduplication: repeated calls don't create duplicate relationships
 *     (handled by KnowledgeGraph's addRelationship upsert)
 */

import type { KnowledgeGraph } from "./graph.js";

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class ConceptLinker {
	constructor(private graph: KnowledgeGraph) {}

	/**
	 * Scan contentText for concept names present in the knowledge graph.
	 * For each match, create a "related_to" relationship from memoryId
	 * to the concept entity.
	 *
	 * Returns the IDs of all concept entities that were linked.
	 */
	linkMemoryToConcepts(memoryId: string, contentText: string): string[] {
		const concepts = this.graph.findEntities({ type: "concept", limit: 1000 });

		if (concepts.length === 0) {
			return [];
		}

		const linkedIds: string[] = [];

		for (const concept of concepts) {
			const escaped = escapeRegex(concept.name);

			// Adaptive boundaries: \b only works at word-char edges.
			// For concept names starting/ending with non-word chars (e.g. "C++"),
			// use lookaround for whitespace or string boundary instead.
			const firstIsWord = /\w/.test(concept.name[0]);
			const lastIsWord = /\w/.test(concept.name[concept.name.length - 1]);
			const startBound = firstIsWord ? "\\b" : "(?<=^|\\s|[^a-zA-Z0-9])";
			const endBound = lastIsWord ? "\\b" : "(?=$|\\s|[^a-zA-Z0-9])";

			const pattern = new RegExp(`${startBound}${escaped}${endBound}`, "i");

			if (pattern.test(contentText)) {
				this.graph.addRelationship(memoryId, concept.id, "related_to");
				linkedIds.push(concept.id);
			}
		}

		return linkedIds;
	}
}
