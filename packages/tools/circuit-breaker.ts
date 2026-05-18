/**
 * Circuit Breaker Pattern
 *
 * States:
 *   CLOSED     - normal operation, requests pass through
 *   OPEN       - failure threshold exceeded, requests fail fast
 *   HALF_OPEN  - probe state, limited requests allowed to test recovery
 */

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {
  /** Number of consecutive failures before opening. Default: 5 */
  failureThreshold?: number;
  /** Number of consecutive successes in HALF_OPEN before closing. Default: 2 */
  successThreshold?: number;
  /** Milliseconds to wait in OPEN before transitioning to HALF_OPEN. Default: 30000 */
  timeout?: number;
  /** Max requests allowed through in HALF_OPEN at once. Default: 1 */
  halfOpenMaxRequests?: number;
  /** Optional fallback function called when circuit is OPEN or on failure */
  fallback?: <T>(...args: unknown[]) => T | Promise<T>;
  /** Optional callback fired on state transitions */
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

export interface CircuitBreakerStats {
  state: CircuitState;
  failures: number;
  successes: number;
  totalCalls: number;
  lastFailureTime: number | null;
  lastStateChangeTime: number;
}

export class CircuitBreakerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CircuitBreakerError";
  }
}

export class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private failures = 0;
  private successes = 0;
  private totalCalls = 0;
  private halfOpenRequests = 0;
  private lastFailureTime: number | null = null;
  private lastStateChangeTime: number = Date.now();

  private readonly failureThreshold: number;
  private readonly successThreshold: number;
  private readonly timeout: number;
  private readonly halfOpenMaxRequests: number;
  private readonly fallback?: <T>(...args: unknown[]) => T | Promise<T>;
  private readonly onStateChange?: (from: CircuitState, to: CircuitState) => void;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.successThreshold = options.successThreshold ?? 2;
    this.timeout = options.timeout ?? 30_000;
    this.halfOpenMaxRequests = options.halfOpenMaxRequests ?? 1;
    this.fallback = options.fallback;
    this.onStateChange = options.onStateChange;
  }

  /** Execute a function through the circuit breaker */
  async execute<T>(fn: (...args: unknown[]) => T | Promise<T>, ...args: unknown[]): Promise<T> {
    this.totalCalls++;

    if (this.state === "OPEN") {
      if (this.shouldAttemptReset()) {
        this.transitionTo("HALF_OPEN");
      } else {
        if (this.fallback) {
          return this.fallback<T>(...args);
        }
        throw new CircuitBreakerError(
          `Circuit is OPEN. Last failure: ${this.lastFailureTime ? new Date(this.lastFailureTime).toISOString() : "unknown"}. Retry after ${this.remainingTimeMs()}ms.`
        );
      }
    }

    if (this.state === "HALF_OPEN") {
      if (this.halfOpenRequests >= this.halfOpenMaxRequests) {
        if (this.fallback) {
          return this.fallback<T>(...args);
        }
        throw new CircuitBreakerError(
          `Circuit is HALF_OPEN and at max probe capacity (${this.halfOpenMaxRequests}).`
        );
      }
      this.halfOpenRequests++;
    }

    try {
      const result = await Promise.resolve(fn(...args));
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      if (this.fallback) {
        return this.fallback<T>(...args);
      }
      throw err;
    }
  }

  /** Current state of the circuit */
  getState(): CircuitState {
    if (this.state === "OPEN" && this.shouldAttemptReset()) {
      this.transitionTo("HALF_OPEN");
    }
    return this.state;
  }

  /** Snapshot of current stats */
  getStats(): CircuitBreakerStats {
    return {
      state: this.getState(),
      failures: this.failures,
      successes: this.successes,
      totalCalls: this.totalCalls,
      lastFailureTime: this.lastFailureTime,
      lastStateChangeTime: this.lastStateChangeTime,
    };
  }

  /** Manually reset circuit to CLOSED */
  reset(): void {
    this.failures = 0;
    this.successes = 0;
    this.halfOpenRequests = 0;
    this.lastFailureTime = null;
    this.transitionTo("CLOSED");
  }

  /** Manually force circuit OPEN (e.g. for maintenance) */
  forceOpen(): void {
    this.transitionTo("OPEN");
  }

  private onSuccess(): void {
    if (this.state === "HALF_OPEN") {
      this.successes++;
      this.halfOpenRequests = Math.max(0, this.halfOpenRequests - 1);
      if (this.successes >= this.successThreshold) {
        this.failures = 0;
        this.successes = 0;
        this.halfOpenRequests = 0;
        this.transitionTo("CLOSED");
      }
    } else {
      // In CLOSED state, reset failure count on success
      this.failures = 0;
    }
  }

  private onFailure(): void {
    this.lastFailureTime = Date.now();
    this.failures++;

    if (this.state === "HALF_OPEN") {
      this.successes = 0;
      this.halfOpenRequests = Math.max(0, this.halfOpenRequests - 1);
      this.transitionTo("OPEN");
      return;
    }

    if (this.state === "CLOSED" && this.failures >= this.failureThreshold) {
      this.transitionTo("OPEN");
    }
  }

  private shouldAttemptReset(): boolean {
    return (
      this.lastFailureTime !== null &&
      Date.now() - this.lastFailureTime >= this.timeout
    );
  }

  private remainingTimeMs(): number {
    if (!this.lastFailureTime) return this.timeout;
    const elapsed = Date.now() - this.lastFailureTime;
    return Math.max(0, this.timeout - elapsed);
  }

  private transitionTo(next: CircuitState): void {
    if (this.state === next) return;
    const prev = this.state;
    this.state = next;
    this.lastStateChangeTime = Date.now();
    if (next === "HALF_OPEN") {
      this.halfOpenRequests = 0;
      this.successes = 0;
    }
    this.onStateChange?.(prev, next);
  }
}
