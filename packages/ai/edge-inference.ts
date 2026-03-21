/**
 * 8gent AI - Edge Inference
 *
 * Lightweight in-process inference for fast local tasks that don't need a
 * full LLM: intent classification, text embedding, similarity, routing.
 *
 * Backend: Ollama /api/embed (nomic-embed-text) - local, no API key required.
 * Future: swap backend to ONNX/WebGPU without changing callers.
 *
 * Inspired by: https://huggingface.co/spaces/webml-community/Nemotron-3-Nano-WebGPU
 * (edge inference pattern - tiny models for fast classification tasks)
 */

import { getEmbeddingCache, cosineSimilarity } from "./embedding-cache";

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const EMBED_MODEL = process.env.EDGE_EMBED_MODEL ?? "nomic-embed-text";

// ============================================
// Core embedding - calls Ollama /api/embed
// ============================================

/**
 * Embed a single text using the local Ollama embedding model.
 * Results are cached - identical inputs return cached vectors.
 */
export async function embed(text: string): Promise<number[]> {
  const cache = getEmbeddingCache();
  const cached = cache.get(text);
  if (cached) return cached;

  const res = await fetch(`${OLLAMA_BASE}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`Ollama embed failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json() as { embeddings?: number[][]; embedding?: number[] };
  // /api/embed returns { embeddings: [[...]] }, older /api/embeddings returns { embedding: [...] }
  const vector = data.embeddings?.[0] ?? data.embedding;
  if (!vector) throw new Error("Ollama embed: no vector in response");

  cache.set(text, vector);
  return vector;
}

/**
 * Embed multiple texts in parallel, returning vectors in the same order.
 */
export async function batchEmbed(texts: string[]): Promise<number[][]> {
  return Promise.all(texts.map(embed));
}

// ============================================
// Similarity
// ============================================

/**
 * Cosine similarity between two texts (0-1, higher = more similar).
 * Checks cache first - skips a round-trip if both are already embedded.
 */
export async function similarity(a: string, b: string): Promise<number> {
  const cache = getEmbeddingCache();
  const cached = cache.similarity(a, b);
  if (cached !== null) return cached;

  const [ea, eb] = await batchEmbed([a, b]);
  return cosineSimilarity(ea, eb);
}

// ============================================
// Classification
// ============================================

/**
 * Classify text into one of the provided categories using embedding similarity.
 * No LLM call needed - purely vector math.
 *
 * @param text - Input text to classify
 * @param categories - Array of category label strings
 * @returns Best matching category and its confidence score (0-1)
 */
export async function classify(
  text: string,
  categories: string[]
): Promise<{ category: string; confidence: number }> {
  if (categories.length === 0) throw new Error("classify: categories must not be empty");

  const [textVec, ...categoryVecs] = await batchEmbed([text, ...categories]);

  let best = categories[0];
  let bestScore = -Infinity;

  for (let i = 0; i < categories.length; i++) {
    const score = cosineSimilarity(textVec, categoryVecs[i]);
    if (score > bestScore) {
      bestScore = score;
      best = categories[i];
    }
  }

  // Normalize to 0-1 range (cosine is -1 to 1, text embeddings rarely go negative)
  const confidence = Math.max(0, Math.min(1, (bestScore + 1) / 2));

  return { category: best, confidence };
}

// ============================================
// Health check
// ============================================

/**
 * Returns true if Ollama is reachable and the embed model is available.
 */
export async function isEdgeInferenceAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) return false;
    const data = await res.json() as { models?: Array<{ name: string }> };
    return (data.models ?? []).some((m) => m.name.startsWith(EMBED_MODEL));
  } catch {
    return false;
  }
}
