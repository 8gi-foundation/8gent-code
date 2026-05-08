/**
 * Artifact Registry — never-compressed index for incremental context compression.
 *
 * Issue #2420. The three approaches surveyed (Facto, OpenAI, Anthropic SDK) all
 * struggled with artifact tracking: file paths, decisions, and code snippets
 * silently vanished mid-session. The registry is a separate store that lives
 * alongside the compressible message history. Every compression cycle reads
 * from it; no compression cycle ever writes over it.
 *
 * Bounded by per-category LRU so the registry itself cannot exhaust context.
 */

export type ArtifactKind = "file" | "decision" | "snippet" | "error" | "command" | "test";

export interface Artifact {
	kind: ArtifactKind;
	key: string;
	value: string;
	addedAt: number;
	lastSeenAt: number;
	hits: number;
}

export interface ArtifactRegistryConfig {
	/** Per-category LRU caps. Older entries drop when cap is hit. */
	caps: Partial<Record<ArtifactKind, number>>;
	/** Truncate the rendered prompt block to at most this many characters. */
	maxRenderChars: number;
}

const DEFAULT_CAPS: Record<ArtifactKind, number> = {
	file: 50,
	decision: 30,
	snippet: 20,
	error: 15,
	command: 30,
	test: 20,
};

export const DEFAULT_REGISTRY_CONFIG: ArtifactRegistryConfig = {
	caps: DEFAULT_CAPS,
	maxRenderChars: 3000,
};

export class ArtifactRegistry {
	private store = new Map<ArtifactKind, Map<string, Artifact>>();
	private config: ArtifactRegistryConfig;

	constructor(config: Partial<ArtifactRegistryConfig> = {}) {
		this.config = {
			caps: { ...DEFAULT_CAPS, ...(config.caps ?? {}) },
			maxRenderChars: config.maxRenderChars ?? DEFAULT_REGISTRY_CONFIG.maxRenderChars,
		};
		for (const k of Object.keys(DEFAULT_CAPS) as ArtifactKind[]) {
			this.store.set(k, new Map());
		}
	}

	private capFor(kind: ArtifactKind): number {
		return this.config.caps[kind] ?? DEFAULT_CAPS[kind];
	}

	add(kind: ArtifactKind, key: string, value: string): Artifact {
		const bucket = this.store.get(kind);
		if (!bucket) throw new Error(`unknown artifact kind: ${kind}`);
		const now = Date.now();
		const existing = bucket.get(key);
		if (existing) {
			existing.value = value;
			existing.lastSeenAt = now;
			existing.hits += 1;
			// LRU touch
			bucket.delete(key);
			bucket.set(key, existing);
			return existing;
		}
		const artifact: Artifact = {
			kind,
			key,
			value,
			addedAt: now,
			lastSeenAt: now,
			hits: 1,
		};
		bucket.set(key, artifact);
		// Evict oldest until under cap
		const cap = this.capFor(kind);
		while (bucket.size > cap) {
			const oldestKey = bucket.keys().next().value;
			if (!oldestKey) break;
			bucket.delete(oldestKey);
		}
		return artifact;
	}

	has(kind: ArtifactKind, key: string): boolean {
		return this.store.get(kind)?.has(key) ?? false;
	}

	get(kind: ArtifactKind, key: string): Artifact | undefined {
		return this.store.get(kind)?.get(key);
	}

	list(kind: ArtifactKind): Artifact[] {
		return Array.from(this.store.get(kind)?.values() ?? []);
	}

	size(kind?: ArtifactKind): number {
		if (kind) return this.store.get(kind)?.size ?? 0;
		let total = 0;
		for (const bucket of this.store.values()) total += bucket.size;
		return total;
	}

	clear(kind?: ArtifactKind): void {
		if (kind) {
			this.store.get(kind)?.clear();
			return;
		}
		for (const bucket of this.store.values()) bucket.clear();
	}

	/**
	 * Render the registry as a compact prompt block. Always-injectable; safe to
	 * paste into a system message after a compression pass. Truncated to the
	 * configured maxRenderChars to avoid runaway growth.
	 */
	render(): string {
		const sections: string[] = [];
		const order: ArtifactKind[] = ["file", "decision", "snippet", "error", "command", "test"];
		const headings: Record<ArtifactKind, string> = {
			file: "Files",
			decision: "Decisions",
			snippet: "Code Snippets",
			error: "Errors Seen",
			command: "Commands Run",
			test: "Tests",
		};
		for (const k of order) {
			const items = this.list(k);
			if (items.length === 0) continue;
			sections.push(`### ${headings[k]} (${items.length})`);
			for (const a of items) {
				const head = a.value.split("\n")[0]?.slice(0, 200) ?? "";
				const suffix = a.value.length > 200 ? " …" : "";
				const tag = a.hits > 1 ? ` [x${a.hits}]` : "";
				sections.push(`- ${a.key}${tag}: ${head}${suffix}`);
			}
		}
		if (sections.length === 0) return "";
		const header = "## Artifact Registry (preserved across compression)";
		const body = [header, ...sections].join("\n");
		if (body.length <= this.config.maxRenderChars) return body;
		// Hard truncate at boundary; keep the header.
		const truncated = body.slice(0, this.config.maxRenderChars - 30);
		return `${truncated}\n…[registry truncated]`;
	}

	/**
	 * Snapshot for metrics / persistence. Counts only — values stay in memory.
	 */
	snapshot(): {
		total: number;
		byKind: Record<ArtifactKind, number>;
	} {
		const byKind = {} as Record<ArtifactKind, number>;
		for (const k of Object.keys(DEFAULT_CAPS) as ArtifactKind[]) {
			byKind[k] = this.size(k);
		}
		return { total: this.size(), byKind };
	}
}
