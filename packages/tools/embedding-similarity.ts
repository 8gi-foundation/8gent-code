/**
 * Compute cosine similarity between two vectors.
 * @param vecA First vector.
 * @param vecB Second vector.
 * @returns Cosine similarity.
 */
export function cosine(vecA: number[], vecB: number[]): number {
  const dot = vecA.reduce((sum, a, i) => sum + a * vecB[i], 0);
  const magA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
  const magB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));
  return dot / (magA * magB);
}

/**
 * Compute Euclidean distance between two vectors.
 * @param vecA First vector.
 * @param vecB Second vector.
 * @returns Euclidean distance.
 */
export function euclidean(vecA: number[], vecB: number[]): number {
  return Math.sqrt(vecA.reduce((sum, a, i) => sum + (a - vecB[i]) ** 2, 0));
}

/**
 * Find nearest neighbors to a query vector.
 * @param query Query vector.
 * @param corpus Corpus of vectors.
 * @param topK Number of top results.
 * @returns Top K results with similarity scores.
 */
export function nearest(query: number[], corpus: number[][], topK: number): { index: number; similarity: number }[] {
  return corpus
    .map((vec, i) => ({ index: i, similarity: cosine(query, vec) }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK);
}

/**
 * Assign vectors to clusters using k-means.
 * @param embeddings Embedding vectors.
 * @param k Number of clusters.
 * @returns Cluster assignments for each vector.
 */
export function cluster(embeddings: number[][], k: number): number[] {
  const centroids = embeddings.slice(0, k);
  return embeddings.map(vec =>
    centroids
      .reduce((minIdx, centroid, idx) => {
        const dist = euclidean(vec, centroid);
        return dist < euclidean(vec, centroids[minIdx]) ? idx : minIdx;
      }, 0)
  );
}

/**
 * Normalize a vector to unit length.
 * @param vec Input vector.
 * @returns Normalized vector.
 */
export function normalize(vec: number[]): number[] {
  const mag = Math.sqrt(vec.reduce((sum, a) => sum + a * a, 0));
  return vec.map(a => a / mag);
}