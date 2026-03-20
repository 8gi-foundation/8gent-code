/**
 * Semantic Recall — clean query interface over the memory store
 *
 * Thin facade that wires together:
 *   - FTS5 full-text search (always available)
 *   - Ollama nomic-embed-text cosine similarity (when available)
 *   - 30% score boost for promoted memories (access_count >= 3)
 *
 * Designed for use in the agent loop — non-blocking, never throws.
 */

import { type MemoryStore } from "./store.js";
import { type SearchResult, type SearchOptions, type MemoryType } from "./types.js";
import { getEmbeddingProvider } from "./embeddings.js";

// ── Recall Options ────────────────────────────────────────────────────

export interface RecallOptions {
  /** Max results (default: 5) */
  limit?: number;
  /** Restrict to specific memory types */
  types?: MemoryType[];
  /** Min importance score 0.0-1.0 (default: 0 — all) */
  minImportance?: number;
  /** Boost promoted memories (access_count >= 3). Default: true */
  boostPromoted?: boolean;
}

// ── SemanticRecall ────────────────────────────────────────────────────

export class SemanticRecall {
  private store: MemoryStore;
  private embeddingReady = false;

  constructor(store: MemoryStore) {
    this.store = store;
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
      limit: limit * 2,
      types: options.types,
      minImportance: options.minImportance ?? 0,
    };

    try {
      const results = await this.store.recall(query, searchOptions);

      if (options.boostPromoted !== false) {
        for (const r of results) {
          if (r.memory.accessCount >= 3 && r.memory.importance >= 0.9) {
            r.score *= 1.3;
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
   * Recall memories and format as plain text for prompt injection.
   * Returns empty string if nothing relevant found.
   */
  async recallAsText(query: string, options: RecallOptions = {}): Promise<string> {
    const results = await this.recall(query, options);
    if (results.length === 0) return "";

    const lines: string[] = ["[Memory]"];
    for (const r of results) {
      const m = r.memory;
      let content = "";
      switch (m.type) {
        case "core":      content = `${m.title}: ${m.content}`; break;
        case "semantic":  content = `${m.key}: ${m.value}`; break;
        case "episodic":  content = m.summary ?? m.content; break;
        case "procedural":content = `${m.name}: ${m.description}`; break;
        case "working":   content = `${m.key}: ${m.value}`; break;
      }
      if (content) lines.push(`- [${m.type}] ${content.slice(0, 200)}`);
    }

    return lines.join("\n");
  }

  isEmbeddingReady(): boolean {
    return this.embeddingReady;
  }

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

export function createSemanticRecall(store: MemoryStore): SemanticRecall {
  return new SemanticRecall(store);
}
