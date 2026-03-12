/**
 * Fixture: FI001 - Add Caching Layer
 *
 * Task: Implement a caching layer for the data fetcher
 * Requirements:
 * - TTL-based cache expiration
 * - Max cache size with LRU eviction
 * - Cache statistics (hits, misses, evictions)
 * - Invalidation by pattern
 */

interface FetchResult<T> {
  data: T;
  timestamp: number;
}

// Base implementation without caching
export class DataFetcher {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  async fetch<T>(path: string): Promise<T> {
    console.log(`Fetching ${this.baseUrl}${path}`);
    const response = await fetch(`${this.baseUrl}${path}`);
    return response.json();
  }

  async fetchUser(id: number): Promise<{ id: number; name: string }> {
    return this.fetch(`/users/${id}`);
  }

  async fetchPost(id: number): Promise<{ id: number; title: string }> {
    return this.fetch(`/posts/${id}`);
  }

  async fetchUserPosts(userId: number): Promise<Array<{ id: number; title: string }>> {
    return this.fetch(`/users/${userId}/posts`);
  }
}

// TODO: Implement CachedDataFetcher with:
// 1. constructor(baseUrl: string, options: CacheOptions)
// 2. Cache options: { ttl: number, maxSize: number }
// 3. getStats(): CacheStats
// 4. invalidate(pattern: string | RegExp): number
// 5. clear(): void

// Expected interface:
// interface CacheOptions {
//   ttl: number;        // Time to live in milliseconds
//   maxSize: number;    // Maximum number of cached items
// }
//
// interface CacheStats {
//   hits: number;
//   misses: number;
//   size: number;
//   evictions: number;
// }
