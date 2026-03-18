/**
 * Embedding Provider for Memory v2
 *
 * Uses Ollama's nomic-embed-text model (768 dimensions) for local embedding generation.
 * Falls back to NullEmbeddingProvider (FTS5-only mode) if Ollama is unavailable.
 *
 * Zero cloud dependencies — fully local-first.
 */

// ── Interface ─────────────────────────────────────────────────────────

export interface EmbeddingProvider {
  generate(text: string): Promise<Float32Array>;
  generateBatch(texts: string[]): Promise<Float32Array[]>;
  readonly dimensions: number;
  readonly model: string;
  readonly available: boolean;
}

// ── Ollama Embedding Provider ─────────────────────────────────────────

const OLLAMA_URL = "http://localhost:11434";
const CONCURRENCY_LIMIT = 4;
const AVAILABILITY_CACHE_MS = 30_000; // 30s

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 768;
  readonly model = "nomic-embed-text:latest";

  private _available: boolean | null = null;
  private _availableCheckedAt = 0;

  get available(): boolean {
    // Return cached value if fresh
    if (this._available !== null && Date.now() - this._availableCheckedAt < AVAILABILITY_CACHE_MS) {
      return this._available;
    }
    // Default to unknown — caller should use checkAvailability() first
    return this._available ?? false;
  }

  /**
   * Check if Ollama is running and the embedding model is available.
   * Caches the result for 30 seconds.
   */
  async checkAvailability(): Promise<boolean> {
    if (this._available !== null && Date.now() - this._availableCheckedAt < AVAILABILITY_CACHE_MS) {
      return this._available;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);

      const response = await fetch(`${OLLAMA_URL}/api/tags`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        this._available = false;
        this._availableCheckedAt = Date.now();
        return false;
      }

      const data = (await response.json()) as { models?: Array<{ name: string }> };
      const models = data.models ?? [];
      this._available = models.some(
        (m) => m.name === this.model || m.name.startsWith("nomic-embed-text")
      );
      this._availableCheckedAt = Date.now();
      return this._available;
    } catch {
      this._available = false;
      this._availableCheckedAt = Date.now();
      return false;
    }
  }

  /**
   * Generate embedding for a single text string.
   * Returns Float32Array of 768 dimensions.
   */
  async generate(text: string): Promise<Float32Array> {
    try {
      const response = await fetch(`${OLLAMA_URL}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, prompt: text }),
      });

      if (!response.ok) {
        throw new Error(`Ollama embedding failed: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as { embedding: number[] };
      return new Float32Array(data.embedding);
    } catch (error) {
      // Mark as unavailable on network errors
      if (error instanceof TypeError && error.message.includes("fetch")) {
        this._available = false;
        this._availableCheckedAt = Date.now();
      }
      throw error;
    }
  }

  /**
   * Generate embeddings for multiple texts with concurrency limiting.
   * Processes up to CONCURRENCY_LIMIT texts in parallel.
   */
  async generateBatch(texts: string[]): Promise<Float32Array[]> {
    const results: Float32Array[] = new Array(texts.length);
    const queue = texts.map((text, index) => ({ text, index }));

    const workers: Promise<void>[] = [];
    for (let i = 0; i < Math.min(CONCURRENCY_LIMIT, queue.length); i++) {
      workers.push(this._processQueue(queue, results));
    }
    await Promise.all(workers);

    return results;
  }

  private async _processQueue(
    queue: Array<{ text: string; index: number }>,
    results: Float32Array[]
  ): Promise<void> {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      results[item.index] = await this.generate(item.text);
    }
  }
}

// ── Null Embedding Provider (Fallback) ────────────────────────────────

export class NullEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 0;
  readonly model = "none";
  readonly available = false;

  async generate(): Promise<Float32Array> {
    return new Float32Array(0);
  }

  async generateBatch(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => new Float32Array(0));
  }
}

// ── Factory ───────────────────────────────────────────────────────────

let _provider: EmbeddingProvider | null = null;

/**
 * Get the embedding provider, initializing on first call.
 * Checks Ollama availability and falls back to NullEmbeddingProvider if unavailable.
 */
export async function getEmbeddingProvider(): Promise<EmbeddingProvider> {
  if (_provider) return _provider;

  const ollama = new OllamaEmbeddingProvider();
  const isAvailable = await ollama.checkAvailability();

  _provider = isAvailable ? ollama : new NullEmbeddingProvider();
  return _provider;
}

/**
 * Reset the provider singleton (for testing).
 */
export function resetEmbeddingProvider(): void {
  _provider = null;
}

// ── Utility: Cosine Similarity ────────────────────────────────────────

/**
 * Calculate cosine similarity between two vectors.
 * Returns 0 if either vector is empty or has zero magnitude.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dot / denominator;
}
