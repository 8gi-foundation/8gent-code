/**
 * ArtifactRegistryStore - the never-compressed index for a session.
 *
 * Tracks files, named entities, and explicit decisions referenced in the
 * conversation. Survives every compression pass verbatim: the compression
 * engine receives the registry as input and the strict prompt forbids
 * dropping any of its entries.
 *
 * Why a registry at all?
 *   The three approaches benchmarked in Nate B Jones' Facto comparison
 *   (Facto incremental, OpenAI high-compression, Anthropic SDK regen) all
 *   degraded on artifact tracking. By splitting artifacts off into a
 *   separate, append-only structure, the compressor only has to summarize
 *   prose, never the load-bearing identifiers.
 */

import type {
	ArtifactRegistry,
	DecisionArtifact,
	EntityArtifact,
	FileArtifact,
	Message,
	SerializedRegistry,
} from "./types";

// ---------------------------------------------------------------------------
// Extraction patterns
// ---------------------------------------------------------------------------

/**
 * File-path matchers. We deliberately err on the side of recall: a slightly
 * noisy registry is cheaper than a missed file reference, because the
 * compression prompt prints the registry verbatim either way.
 */
const FILE_PATTERNS: RegExp[] = [
	// JSON-style tool args (read_file/write_file/edit_file): "path": "..."
	/"(?:file_?path|path)"\s*:\s*"([^"]+)"/g,
	// Shell-style: "cat foo/bar.ts", "less /etc/hosts"
	/(?:^|[^\w])(?:cat|less|head|tail|nl|wc)\s+([^\s;|&"'`]+\.[a-zA-Z]{1,6})/g,
	// Bare path-with-extension (most repo-relative file references)
	/(?:^|[\s(`"'])([./]?(?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z]{1,6})/g,
	/(?:^|[\s(`"'])([\w.-]+\.(?:ts|tsx|js|jsx|mts|cts|json|md|toml|yaml|yml|sh|py|rs|go|sql|html|css|env))(?=$|[\s.,)`"'])/g,
];

/** Pull file paths out of a message body. */
function extractFilesFromText(text: string): string[] {
	const found = new Set<string>();
	for (const pattern of FILE_PATTERNS) {
		pattern.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(text)) !== null) {
			const candidate = match[1].trim();
			if (candidate.length === 0) continue;
			if (candidate.length > 500) continue; // ignore wild matches
			found.add(candidate);
		}
	}
	return Array.from(found);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class ArtifactRegistryStore {
	private files = new Map<string, FileArtifact>();
	private entities = new Map<string, EntityArtifact>();
	private decisions: DecisionArtifact[] = [];

	trackFile(path: string, lastState = "referenced"): void {
		if (!path) return;
		const existing = this.files.get(path);
		this.files.set(path, {
			path,
			lastState: lastState || existing?.lastState || "referenced",
			lastMentioned: Date.now(),
		});
	}

	trackEntity(name: string, type: string, description: string): void {
		if (!name) return;
		this.entities.set(name, {
			name,
			type: type || "unknown",
			description: description || "",
			lastMentioned: Date.now(),
		});
	}

	trackDecision(summary: string, rationale: string): void {
		if (!summary) return;
		this.decisions.push({
			timestamp: Date.now(),
			summary,
			rationale: rationale || "",
		});
	}

	/**
	 * Walk a single message and pick up any file references. Cheap and
	 * idempotent: same path mentioned twice just bumps `lastMentioned`.
	 *
	 * Note: entities and decisions still need to be tracked explicitly via
	 * `trackEntity` / `trackDecision`. We don't try to NLP them out of the
	 * conversation because false positives would pollute the registry, and
	 * the registry is the part that must remain trustworthy.
	 */
	ingestMessage(message: Message): void {
		const paths = extractFilesFromText(message.content);
		for (const path of paths) {
			this.trackFile(path);
		}
	}

	ingestMessages(messages: Message[]): void {
		for (const msg of messages) {
			this.ingestMessage(msg);
		}
	}

	getRegistry(): ArtifactRegistry {
		return {
			files: this.files,
			entities: this.entities,
			decisions: this.decisions,
		};
	}

	toJSON(): SerializedRegistry {
		return {
			files: Array.from(this.files.values()),
			entities: Array.from(this.entities.values()),
			decisions: [...this.decisions],
		};
	}

	/**
	 * Serialize the registry for inclusion in a compression prompt or as
	 * a sticky system message. Stable ordering by path/name keeps prompts
	 * cache-friendly across calls.
	 */
	render(): string {
		const lines: string[] = ["## Artifact Registry (preserve verbatim)"];

		const files = Array.from(this.files.values()).sort((a, b) => a.path.localeCompare(b.path));
		if (files.length > 0) {
			lines.push("### Files");
			for (const f of files) {
				lines.push(`- ${f.path} (${f.lastState})`);
			}
		}

		const entities = Array.from(this.entities.values()).sort((a, b) =>
			a.name.localeCompare(b.name),
		);
		if (entities.length > 0) {
			lines.push("### Entities");
			for (const e of entities) {
				const desc = e.description ? ` - ${e.description}` : "";
				lines.push(`- ${e.name} [${e.type}]${desc}`);
			}
		}

		if (this.decisions.length > 0) {
			lines.push("### Decisions");
			for (const d of this.decisions) {
				const rationale = d.rationale ? ` (${d.rationale})` : "";
				lines.push(`- ${d.summary}${rationale}`);
			}
		}

		return lines.join("\n");
	}

	stats(): { files: number; entities: number; decisions: number } {
		return {
			files: this.files.size,
			entities: this.entities.size,
			decisions: this.decisions.length,
		};
	}

	/**
	 * Restore from a previously-serialized snapshot. Used when resuming a
	 * session from a checkpoint that included a registry export.
	 */
	static fromJSON(snapshot: SerializedRegistry): ArtifactRegistryStore {
		const store = new ArtifactRegistryStore();
		for (const file of snapshot.files) {
			store.files.set(file.path, { ...file });
		}
		for (const entity of snapshot.entities) {
			store.entities.set(entity.name, { ...entity });
		}
		store.decisions = snapshot.decisions.map((d) => ({ ...d }));
		return store;
	}
}

export { extractFilesFromText };
