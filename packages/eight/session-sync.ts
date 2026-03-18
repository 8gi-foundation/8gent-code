/**
 * SessionSyncManager — Fire-and-forget Convex session synchronization
 *
 * Syncs agent session data (tokens, tool calls) to Convex in the background.
 * All operations are non-blocking. Convex being unavailable is handled silently.
 *
 * Architecture:
 * - On session start: creates a Convex session record
 * - On each turn: batches token/tool-call deltas
 * - Every 10 seconds (or on session end): flushes accumulated deltas
 * - On session end: final sync with totals
 * - Offline: queues mutations via ConvexClientWrapper's built-in queue
 */

/** Accumulated deltas between flushes */
interface PendingDeltas {
  tokensIn: number;
  tokensOut: number;
  toolCalls: number;
}

export class SessionSyncManager {
  private convexSessionId: string | null = null;
  private pending: PendingDeltas = { tokensIn: 0, tokensOut: 0, toolCalls: 0 };
  private totals: PendingDeltas = { tokensIn: 0, tokensOut: 0, toolCalls: 0 };
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private enabled: boolean;

  // Lazily resolved — dynamic imports so @8gent/db is optional
  private _client: any = null;
  private _api: any = null;
  private _resolved = false;
  private _resolving: Promise<boolean> | null = null;

  constructor(enabled: boolean = true) {
    this.enabled = enabled;
  }

  /**
   * Lazily resolve the Convex client and API.
   * Returns true if Convex is available, false otherwise.
   * Caches the result so subsequent calls are instant.
   */
  private async resolveConvex(): Promise<boolean> {
    if (this._resolved) return this._client !== null;

    // Prevent concurrent resolution attempts
    if (this._resolving) return this._resolving;

    this._resolving = (async () => {
      try {
        const { getConvexClient } = await import("../db/client.js");
        const { api } = await import("../db/convex/_generated/api.js");
        this._client = getConvexClient();
        this._api = api;
        this._resolved = true;
        return true;
      } catch {
        // @8gent/db not available — run without sync
        this._resolved = true;
        return false;
      }
    })();

    return this._resolving;
  }

  /**
   * Start tracking a session in Convex.
   * Fire-and-forget — never blocks the agent loop.
   */
  async startSession(model: string, provider: string): Promise<void> {
    if (!this.enabled) return;

    try {
      const available = await this.resolveConvex();
      if (!available) return;

      const result = await this._client.mutation(this._api.sessions.start, {
        model: model || "unknown",
        provider: provider || "ollama",
      });

      if (result) {
        this.convexSessionId = result;
        this.started = true;

        // Start the periodic flush timer (every 10 seconds)
        this.flushTimer = setInterval(() => {
          this.flush().catch(() => {});
        }, 10_000);

        // Don't let the timer keep the process alive
        if (this.flushTimer && typeof this.flushTimer === "object" && "unref" in this.flushTimer) {
          this.flushTimer.unref();
        }
      }
    } catch {
      // Silent — session sync is best-effort
    }
  }

  /**
   * Record token usage from a completed step.
   * Accumulates deltas in memory — flushed periodically or on end.
   */
  recordTokens(promptTokens: number, completionTokens: number): void {
    if (!this.enabled || !this.started) return;

    this.pending.tokensIn += promptTokens;
    this.pending.tokensOut += completionTokens;
    this.totals.tokensIn += promptTokens;
    this.totals.tokensOut += completionTokens;
  }

  /**
   * Record a tool call.
   * Accumulates in the pending batch.
   */
  recordToolCall(): void {
    if (!this.enabled || !this.started) return;

    this.pending.toolCalls += 1;
    this.totals.toolCalls += 1;
  }

  /**
   * Flush accumulated deltas to Convex.
   * Called by the periodic timer and on session end.
   */
  async flush(): Promise<void> {
    if (!this.convexSessionId) return;
    if (this.pending.tokensIn === 0 && this.pending.tokensOut === 0 && this.pending.toolCalls === 0) {
      return; // Nothing to flush
    }

    const batch = { ...this.pending };
    this.pending = { tokensIn: 0, tokensOut: 0, toolCalls: 0 };

    try {
      const available = await this.resolveConvex();
      if (!available) return;

      await this._client.mutation(this._api.sessions.updateCounts, {
        sessionId: this.convexSessionId,
        tokensInDelta: batch.tokensIn,
        tokensOutDelta: batch.tokensOut,
        toolCallsDelta: batch.toolCalls,
      });
    } catch {
      // Re-add failed deltas back to pending for next flush
      this.pending.tokensIn += batch.tokensIn;
      this.pending.tokensOut += batch.tokensOut;
      this.pending.toolCalls += batch.toolCalls;
    }
  }

  /**
   * End the session in Convex with final totals.
   * Flushes any remaining deltas first, then marks the session as ended.
   */
  async endSession(): Promise<void> {
    if (!this.enabled || !this.convexSessionId) return;

    // Stop the periodic flush timer
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    try {
      const available = await this.resolveConvex();
      if (!available) return;

      await this._client.mutation(this._api.sessions.end, {
        sessionId: this.convexSessionId,
        tokensIn: this.totals.tokensIn,
        tokensOut: this.totals.tokensOut,
        toolCalls: this.totals.toolCalls,
      });
    } catch {
      // Silent — cleanup should never throw
    }

    this.convexSessionId = null;
    this.started = false;
  }

  /**
   * Check if sync is active and connected to Convex.
   */
  isActive(): boolean {
    return this.started && this.convexSessionId !== null;
  }

  /**
   * Get the Convex session ID (for debugging/logging).
   */
  getConvexSessionId(): string | null {
    return this.convexSessionId;
  }

  /**
   * Get current accumulated totals.
   */
  getTotals(): Readonly<PendingDeltas> {
    return { ...this.totals };
  }
}
