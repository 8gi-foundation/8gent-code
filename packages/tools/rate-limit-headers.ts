/**
 * HTTP Rate Limit Header Parser
 *
 * Parses X-RateLimit-* and RateLimit-* headers from HTTP responses.
 * Calculates wait times and tracks per-host limits.
 */

export interface RateLimitInfo {
  limit: number | null;
  remaining: number | null;
  reset: number | null; // Unix timestamp (seconds)
  retryAfter: number | null; // seconds
}

/**
 * Parses rate limit headers from a Headers object or plain record.
 * Supports both X-RateLimit-* (GitHub, OpenAI) and RateLimit-* (IETF draft) conventions.
 */
export function parseRateLimitHeaders(
  headers: Headers | Record<string, string>
): RateLimitInfo {
  const get = (key: string): string | null => {
    if (headers instanceof Headers) return headers.get(key);
    return headers[key] ?? headers[key.toLowerCase()] ?? null;
  };

  const toNum = (val: string | null): number | null => {
    if (val === null) return null;
    const n = parseInt(val, 10);
    return isNaN(n) ? null : n;
  };

  // Limit - how many requests allowed per window
  const limit =
    toNum(get("X-RateLimit-Limit")) ??
    toNum(get("RateLimit-Limit")) ??
    toNum(get("x-rate-limit-limit")) ??
    null;

  // Remaining - how many requests left in current window
  const remaining =
    toNum(get("X-RateLimit-Remaining")) ??
    toNum(get("RateLimit-Remaining")) ??
    toNum(get("x-rate-limit-remaining")) ??
    null;

  // Reset - Unix timestamp when window resets
  const resetRaw =
    get("X-RateLimit-Reset") ??
    get("RateLimit-Reset") ??
    get("x-rate-limit-reset") ??
    null;

  let reset: number | null = toNum(resetRaw);
  // Some APIs use relative seconds (e.g. "60") instead of epoch timestamp
  if (reset !== null && reset < 1_000_000_000) {
    reset = Math.floor(Date.now() / 1000) + reset;
  }

  // Retry-After - explicit wait instruction (seconds or HTTP-date)
  const retryAfterRaw = get("Retry-After") ?? get("retry-after") ?? null;
  let retryAfter: number | null = null;
  if (retryAfterRaw !== null) {
    const parsed = parseInt(retryAfterRaw, 10);
    if (!isNaN(parsed)) {
      retryAfter = parsed;
    } else {
      // Attempt HTTP-date parse
      const date = new Date(retryAfterRaw);
      if (!isNaN(date.getTime())) {
        retryAfter = Math.max(0, Math.ceil((date.getTime() - Date.now()) / 1000));
      }
    }
  }

  return { limit, remaining, reset, retryAfter };
}

/**
 * Returns the number of milliseconds to wait before the next request.
 * Returns 0 if no wait is needed.
 */
export function shouldWait(headers: Headers | Record<string, string>): number {
  const info = parseRateLimitHeaders(headers);

  // Explicit Retry-After takes highest priority
  if (info.retryAfter !== null && info.retryAfter > 0) {
    return info.retryAfter * 1000;
  }

  // If no remaining requests, wait until reset
  if (info.remaining !== null && info.remaining <= 0 && info.reset !== null) {
    const nowSec = Date.now() / 1000;
    const waitSec = info.reset - nowSec;
    return waitSec > 0 ? Math.ceil(waitSec * 1000) : 0;
  }

  return 0;
}

/**
 * Tracks rate limit state per host across multiple requests.
 * Call record() after each response, query() before each request.
 */
export class RateLimitTracker {
  private store = new Map<string, RateLimitInfo & { recordedAt: number }>();

  /**
   * Record rate limit headers for a given host.
   */
  record(host: string, headers: Headers | Record<string, string>): void {
    const info = parseRateLimitHeaders(headers);
    this.store.set(host, { ...info, recordedAt: Date.now() });
  }

  /**
   * Returns milliseconds to wait before the next request to host.
   * Returns 0 if no wait is needed or host is unknown.
   */
  waitFor(host: string): number {
    const entry = this.store.get(host);
    if (!entry) return 0;

    if (entry.retryAfter !== null && entry.retryAfter > 0) {
      const elapsed = (Date.now() - entry.recordedAt) / 1000;
      const remaining = entry.retryAfter - elapsed;
      return remaining > 0 ? Math.ceil(remaining * 1000) : 0;
    }

    if (entry.remaining !== null && entry.remaining <= 0 && entry.reset !== null) {
      const nowSec = Date.now() / 1000;
      const waitSec = entry.reset - nowSec;
      return waitSec > 0 ? Math.ceil(waitSec * 1000) : 0;
    }

    return 0;
  }

  /**
   * Returns current rate limit info for a host, or null if unknown.
   */
  get(host: string): RateLimitInfo | null {
    const entry = this.store.get(host);
    if (!entry) return null;
    const { recordedAt: _, ...info } = entry;
    return info;
  }

  /**
   * Clears all tracked state.
   */
  clear(): void {
    this.store.clear();
  }
}
