/**
 * @8gent/db — Convex Client Wrapper for Bun
 *
 * Provides a server-side ConvexClient that works in the Bun runtime.
 * Handles auth token injection, offline mode, and connection lifecycle.
 *
 * Usage:
 *   import { getConvexClient, withConvex } from "@8gent/db";
 *
 *   const client = getConvexClient();
 *   const user = await client.query(api.users.getByClerkId, { clerkId: "..." });
 */

import { ConvexClient } from "convex/browser";
import type { FunctionReference, FunctionArgs, FunctionReturnType } from "convex/server";

// ============================================
// Types
// ============================================

export interface ConvexClientConfig {
  /** Convex deployment URL (e.g., "https://xxx.convex.cloud"). */
  url: string;
  /** Function that returns the current auth token. */
  tokenProvider?: () => Promise<string | null>;
  /** Whether to operate in offline mode (skip all network calls). */
  offline?: boolean;
}

// ============================================
// ConvexClientWrapper
// ============================================

/**
 * Wrapper around Convex's ConvexClient for Bun server-side usage.
 *
 * Features:
 * - Lazy initialization (doesn't connect until first query/mutation)
 * - Auth token injection via a provider function
 * - Offline mode: returns null for queries, queues mutations
 * - Automatic reconnection on network errors
 */
export class ConvexClientWrapper {
  private client: ConvexClient | null = null;
  private config: ConvexClientConfig;
  private connected = false;
  private mutationQueue: Array<{ fn: any; args: any }> = [];

  constructor(config: ConvexClientConfig) {
    this.config = config;
  }

  // ---------- Connection ----------

  /**
   * Ensure the client is connected. Called lazily on first operation.
   */
  private async ensureConnected(): Promise<ConvexClient | null> {
    if (this.config.offline) return null;
    if (this.client && this.connected) return this.client;

    if (!this.config.url) {
      console.warn(
        "[8gent/db] No CONVEX_URL configured. Running in offline mode.",
      );
      this.config.offline = true;
      return null;
    }

    try {
      this.client = new ConvexClient(this.config.url);

      // Set auth if a token provider is configured
      if (this.config.tokenProvider) {
        this.client.setAuth(this.config.tokenProvider);
      }

      this.connected = true;

      // Flush queued mutations
      await this.flushQueue();

      return this.client;
    } catch (error) {
      console.warn(
        `[8gent/db] Failed to connect to Convex: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  // ---------- Query / Mutation ----------

  /**
   * Execute a Convex query.
   * Returns null if offline or if the query fails.
   */
  async query<F extends FunctionReference<"query">>(
    fn: F,
    args: FunctionArgs<F>,
  ): Promise<FunctionReturnType<F> | null> {
    const client = await this.ensureConnected();
    if (!client) return null;

    try {
      return await client.query(fn, args);
    } catch (error) {
      console.warn(
        `[8gent/db] Query failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Execute a Convex mutation.
   * Queues the mutation if offline, executes immediately if connected.
   */
  async mutation<F extends FunctionReference<"mutation">>(
    fn: F,
    args: FunctionArgs<F>,
  ): Promise<FunctionReturnType<F> | null> {
    const client = await this.ensureConnected();

    if (!client) {
      // Queue for later
      this.mutationQueue.push({ fn, args });
      return null;
    }

    try {
      return await client.mutation(fn, args);
    } catch (error) {
      console.warn(
        `[8gent/db] Mutation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      // Queue failed mutation for retry
      this.mutationQueue.push({ fn, args });
      return null;
    }
  }

  // ---------- Auth ----------

  /**
   * Set the auth token provider.
   * The provider is called before each request to get a fresh token.
   */
  setAuth(tokenProvider: () => Promise<string | null>): void {
    this.config.tokenProvider = tokenProvider;
    if (this.client) {
      this.client.setAuth(tokenProvider);
    }
  }

  /**
   * Clear auth (switch to anonymous queries).
   */
  clearAuth(): void {
    this.config.tokenProvider = undefined;
    // ConvexClient doesn't have a clearAuth, so we'd recreate on next call
    if (this.client) {
      this.connected = false;
      this.client = null;
    }
  }

  // ---------- Offline Queue ----------

  /**
   * Flush queued mutations (after reconnecting).
   */
  private async flushQueue(): Promise<void> {
    if (!this.client || this.mutationQueue.length === 0) return;

    const queue = [...this.mutationQueue];
    this.mutationQueue = [];

    for (const { fn, args } of queue) {
      try {
        await this.client.mutation(fn, args);
      } catch (error) {
        console.warn(
          `[8gent/db] Failed to flush queued mutation: ${error instanceof Error ? error.message : String(error)}`,
        );
        // Re-queue failed items
        this.mutationQueue.push({ fn, args });
      }
    }
  }

  /** Get the number of queued mutations. */
  get queuedMutations(): number {
    return this.mutationQueue.length;
  }

  // ---------- Lifecycle ----------

  /** Check if the client is connected. */
  get isConnected(): boolean {
    return this.connected;
  }

  /** Check if the client is in offline mode. */
  get isOffline(): boolean {
    return this.config.offline ?? false;
  }

  /**
   * Close the client connection.
   * Call on app shutdown.
   */
  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.connected = false;
    }
  }
}

// ============================================
// Singleton
// ============================================

let _client: ConvexClientWrapper | null = null;

/**
 * Get (or create) the global Convex client singleton.
 *
 * Configuration is resolved from:
 * 1. Explicit config parameter
 * 2. CONVEX_URL environment variable
 * 3. Offline mode (if no URL available)
 */
export function getConvexClient(
  config?: Partial<ConvexClientConfig>,
): ConvexClientWrapper {
  if (!_client) {
    const url = config?.url || process.env.CONVEX_URL || "";
    _client = new ConvexClientWrapper({
      url,
      offline: !url,
      ...config,
    });
  }
  return _client;
}

/**
 * Execute a callback with the Convex client.
 * Convenience wrapper that handles the common pattern.
 */
export async function withConvex<T>(
  fn: (client: ConvexClientWrapper) => Promise<T>,
): Promise<T | null> {
  try {
    const client = getConvexClient();
    return await fn(client);
  } catch {
    return null;
  }
}

// Re-export types
export type { ConvexClientConfig };
export { ConvexClientWrapper as ConvexClient };
