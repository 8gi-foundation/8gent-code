/**
 * Semantic Recall — clean query interface over the memory store
 *
 * Thin facade that wires together:
 *   - FTS5 full-text search (always available)
 *   - Ollama nomic-embed-text cosine similarity (when available)
 *   - Frequency-boost for promoted memories
 *
 * Designed for use in the agent loop — stays non-blocking, never throws.
 */

import { type MemoryStore } from "./store.js";
import { type SearchResult, type SearchOptions, type MemoryType } from "./types.js";
import { getEmbeddingProvider } from "./embeddings.js";

// ── Recall Options ────────────────────────────────────────────────────

export interface RecallOptions {
  /** Max results to return (default: 5) */
  limit?: number;
  /** Restrict to specific memory types */
  types?: MemoryType[];
  /** Minimum importance score 0.0-1.0 (default: 0.0 — all) */
  minImportance?: number;
  /**
   * Whether to boost promoted memories (access_count >= 3, importance = 1.0)
   * Default: true
   */
  boostPromoted?: boolean;
}

// ── SemanticRecall ────────────────────────────────────────────────────

export class SemanticRecall {
  private store: MemoryStore;
  private embeddingReady = false;

  constructor(store: MemoryStore) {
    this.store = store;
    // Warm up embedding provider in background — don't block construction
    this._warmEmbeddings();
  }

  /**
   * Recall memories relevant to a query.
   * Returns results sorted by combined FTS + vector score.
   * Never throws — returns empty array on failure.
   */
  async recall(query: string, options: RecallOptions = {}): Promise<SearchResult[]> {
    if (!query.trim()) return [];

    const limit = options.limit ?? 5;
    const searchOptions: SearchOptions = {
      limit: limit * 2, // fetch extra, then re-rank
      types: options.types,
      minImportance: options.minImportance ?? 0,
    };

    try {
      const results = await this.store.recall(query, searchOptions);

      // Boost promoted memories (high recall count = high signal)
      if (options.boostPromoted !== false) {
        for (const r of results) {
          if (r.memory.accessCount >= 3 && r.memory.importance >= 0.9) {
            r.score *= 1.3; // 30% boost for core knowledge
          }
        }
        results.sort((a, b) => b.score - a.score);
      }

      return results.slice(0, limit);
    } catch {
      return [];
    }
  }

  /**
   * Recall memories and format them as a plain text block
   * suitable for injecting into a prompt context window.
   *
   * Returns empty string if no relevant memories found.
   */
  async recallAsText(query: string, options: RecallOptions = {}): Promise<string> {
    const results = await this.recall(query, options);
    if (results.length === 0) return "";

    const lines: string[] = ["[Memory]"];
    for (const r of results) {
      const m = r.memory;
      let content = "";

      switch (m.type) {
        case "core":
          content = `${m.title}: ${m.content}`;
          break;
        case "semantic":
          content = `${m.key}: ${m.value}`;
          break;
        case "episodic":
          content = m.summary ?? m.content;
          break;
        case "procedural":
          content = `${m.name}: ${m.description}`;
          break;
        case "working":
          content = `${m.key}: ${m.value}`;
          break;
      }

      if (content) {
        lines.push(`- [${m.type}] ${content.slice(0, 200)}`);
      }
    }

    return lines.join("\n");
  }

  /**
   * Check if the embedding provider is ready for vector search.
   */
  isEmbeddingReady(): boolean {
    return this.embeddingReady;
  }

  // ── Private ───────────────────────────────────────────────────────

  private async _warmEmbeddings(): Promise<void> {
    try {
      const provider = await getEmbeddingProvider();
      this.embeddingReady = provider.available;
      if (this.embeddingReady) {
        this.store.setEmbeddingProvider(provider);
      }
    } catch {
      this.embeddingReady = false;
    }
  }
}

// ── Factory ───────────────────────────────────────────────────────────

/**
 * Create a SemanticRecall instance from a MemoryStore.
 * Embedding warm-up happens in the background — first recall may be FTS-only.
 */
export function createSemanticRecall(store: MemoryStore): SemanticRecall {
  return new SemanticRecall(store);
}
