/**
 * 8gent Code - Tool Rate Limiter
 *
 * Sliding window rate limiter to prevent LLM loops from exhausting resources.
 * No external dependencies - uses simple timestamp arrays.
 */

export interface RateLimitConfig {
  /** Max invocations allowed within the window */
  maxCalls: number;
  /** Window size in milliseconds */
  windowMs: number;
}

/** Per-tool rate limit overrides (calls per minute) */
const TOOL_LIMITS: Record<string, number> = {
  run_command: 30,
  web_fetch: 20,
  web_search: 20,
  write_file: 50,
  spawn_agent: 5,
};

/** Default limit for tools not listed above */
const DEFAULT_LIMIT = 100;

/** Window size - 60 seconds */
const WINDOW_MS = 60_000;

export class RateLimiter {
  /** Map of tool name to array of call timestamps */
  private windows: Map<string, number[]> = new Map();

  /**
   * Check if a tool call is allowed. If allowed, records the call.
   * Returns null if allowed, or an error message string if rate limited.
   */
  check(toolName: string): string | null {
    const now = Date.now();
    const limit = TOOL_LIMITS[toolName] ?? DEFAULT_LIMIT;
    const cutoff = now - WINDOW_MS;

    // Get or create the window for this tool
    let timestamps = this.windows.get(toolName);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(toolName, timestamps);
    }

    // Prune expired timestamps (older than window)
    // Find first index that's within the window
    let firstValid = 0;
    while (firstValid < timestamps.length && timestamps[firstValid] <= cutoff) {
      firstValid++;
    }
    if (firstValid > 0) {
      timestamps.splice(0, firstValid);
    }

    // Check limit
    if (timestamps.length >= limit) {
      // Calculate when the oldest call in the window expires
      const oldestInWindow = timestamps[0];
      const waitSeconds = Math.ceil((oldestInWindow + WINDOW_MS - now) / 1000);
      return `Rate limit exceeded for ${toolName} (${limit}/min). Wait ${waitSeconds} seconds.`;
    }

    // Record this call
    timestamps.push(now);
    return null;
  }

  /** Reset all rate limit windows (useful for testing) */
  reset(): void {
    this.windows.clear();
  }

  /** Reset a specific tool's window */
  resetTool(toolName: string): void {
    this.windows.delete(toolName);
  }
}
