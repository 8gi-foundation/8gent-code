# embedding-similarity

Cosine similarity and nearest-neighbor search over embedding vectors.

## Requirements
- cosine(vecA, vecB): dot product / (|a| * |b|)
- euclidean(vecA, vecB): L2 distance
- nearest(query, corpus[], topK): returns topK results with similarity scores
- cluster(embeddings[], k): simple k-means cluster assignment
- normalize(vec): unit-length normalization

## Status

Quarantine - pending review.

## Location

`packages/tools/embedding-similarity.ts`
