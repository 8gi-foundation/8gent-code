/**
 * retry-circuit
 *
 * Combines retry logic and a circuit breaker into one resilient() wrapper.
 * Protects downstream calls from cascading failure while retrying transient errors.
 *
 * Circuit states:
 *   CLOSED    - normal operation, requests pass through
 *   OPEN      - circuit tripped, requests fail fast without calling fn
 *   HALF_OPEN - probe state, one request allowed to test recovery
 */

export interface ResilientOptions {
  /** Max retry attempts per call (default: 3) */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff (default: 200) */
  backoff?: number;
  /** Max backoff delay cap in ms (default: 5000) */
  maxBackoff?: number;
  /** Consecutive failures before opening the circuit (default: 5) */
  circuitThreshold?: number;
  /** Time in ms the circuit stays OPEN before probing (default: 30000) */
  circuitTimeout?: number;
  /** Called on each failed attempt before a retry */
  onRetry?: (error: unknown, attempt: number) => void;
  /** Called when circuit state changes */
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface ResilientStats {
  state: CircuitState;
  /** Total successful calls */
  successCount: number;
  /** Total failed calls (after all retries exhausted) */
  failureCount: number;
  /** Total calls rejected due to open circuit */
  rejectedCount: number;
  /** Consecutive failures since last success */
  consecutiveFailures: number;
  /** Timestamp (ms) when circuit was last opened, or null */
  openedAt: number | null;
}

export interface ResilientFn<T> {
  (): Promise<T>;
  stats(): ResilientStats;
  reset(): void;
}

export class CircuitOpenError extends Error {
  constructor() {
    super("Circuit breaker is OPEN - call rejected");
    this.name = "CircuitOpenError";
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function jitteredBackoff(attempt: number, base: number, max: number): number {
  return Math.min(base * 2 ** attempt + Math.random() * base, max);
}

/**
 * Wrap an async function with combined retry + circuit breaker logic.
 *
 * @example
 * const fetch = resilient(() => callExternalAPI(), {
 *   maxRetries: 3,
 *   backoff: 300,
 *   circuitThreshold: 5,
 *   circuitTimeout: 15_000,
 * });
 *
 * const data = await fetch();
 * console.log(fetch.stats());
 */
export function resilient<T>(
  fn: () => Promise<T>,
  options: ResilientOptions = {}
): ResilientFn<T> {
  const maxRetries = options.maxRetries ?? 3;
  const backoff = options.backoff ?? 200;
  const maxBackoff = options.maxBackoff ?? 5000;
  const circuitThreshold = options.circuitThreshold ?? 5;
  const circuitTimeout = options.circuitTimeout ?? 30_000;

  const s: ResilientStats = {
    state: "CLOSED",
    successCount: 0,
    failureCount: 0,
    rejectedCount: 0,
    consecutiveFailures: 0,
    openedAt: null,
  };

  function transition(to: CircuitState): void {
    const from = s.state;
    if (from === to) return;
    s.state = to;
    if (to === "OPEN") s.openedAt = Date.now();
    options.onStateChange?.(from, to);
  }

  function recordSuccess(): void {
    s.successCount++;
    s.consecutiveFailures = 0;
    if (s.state === "HALF_OPEN") transition("CLOSED");
  }

  function recordFailure(): void {
    s.failureCount++;
    s.consecutiveFailures++;
    if (s.state === "HALF_OPEN" || s.consecutiveFailures >= circuitThreshold) {
      transition("OPEN");
    }
  }

  function checkCircuit(): void {
    if (s.state === "CLOSED") return;
    if (s.state === "OPEN") {
      const elapsed = Date.now() - (s.openedAt ?? 0);
      if (elapsed >= circuitTimeout) {
        transition("HALF_OPEN");
        return;
      }
      s.rejectedCount++;
      throw new CircuitOpenError();
    }
    // HALF_OPEN - let the probe through
  }

  const wrapped = async (): Promise<T> => {
    checkCircuit();

    let lastError: unknown;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const result = await fn();
        recordSuccess();
        return result;
      } catch (err) {
        lastError = err;
        options.onRetry?.(err, attempt + 1);
        if (attempt < maxRetries - 1) {
          await sleep(jitteredBackoff(attempt, backoff, maxBackoff));
        }
      }
    }

    recordFailure();
    throw lastError;
  };

  (wrapped as ResilientFn<T>).stats = () => ({ ...s });
  (wrapped as ResilientFn<T>).reset = () => {
    s.state = "CLOSED";
    s.successCount = 0;
    s.failureCount = 0;
    s.rejectedCount = 0;
    s.consecutiveFailures = 0;
    s.openedAt = null;
  };

  return wrapped as ResilientFn<T>;
}
