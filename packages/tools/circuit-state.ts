/**
 * CircuitState - State machine for the circuit breaker pattern.
 *
 * States:
 *   closed   - normal operation, requests pass through
 *   open     - tripped, requests blocked until cooldown expires
 *   halfOpen - cooldown expired, one probe request allowed to test recovery
 */

export type CircuitBreakerState = "closed" | "open" | "halfOpen";

export interface CircuitStateConfig {
  /** Number of consecutive failures before tripping to open. Default: 5 */
  failureThreshold?: number;
  /** Number of consecutive successes in halfOpen to return to closed. Default: 2 */
  successThreshold?: number;
  /** Milliseconds to wait in open state before moving to halfOpen. Default: 30000 */
  cooldownMs?: number;
  /** Called whenever state transitions occur. */
  onStateChange?: (from: CircuitBreakerState, to: CircuitBreakerState) => void;
}

export class CircuitState {
  private state: CircuitBreakerState = "closed";
  private failureCount = 0;
  private successCount = 0;
  private openedAt: number | null = null;

  private readonly failureThreshold: number;
  private readonly successThreshold: number;
  private readonly cooldownMs: number;
  private readonly onStateChange?: (from: CircuitBreakerState, to: CircuitBreakerState) => void;

  constructor(config: CircuitStateConfig = {}) {
    this.failureThreshold = config.failureThreshold ?? 5;
    this.successThreshold = config.successThreshold ?? 2;
    this.cooldownMs = config.cooldownMs ?? 30_000;
    this.onStateChange = config.onStateChange;
  }

  /** Current state of the circuit. */
  getState(): CircuitBreakerState {
    this._checkCooldown();
    return this.state;
  }

  /**
   * Returns true if a request is allowed to proceed.
   * - closed: always true
   * - open: false (blocked)
   * - halfOpen: true for one probe request
   */
  canExecute(): boolean {
    this._checkCooldown();
    return this.state === "closed" || this.state === "halfOpen";
  }

  /** Record a successful operation. Resets failure count; closes circuit if in halfOpen. */
  recordSuccess(): void {
    this._checkCooldown();

    if (this.state === "halfOpen") {
      this.successCount += 1;
      if (this.successCount >= this.successThreshold) {
        this.reset();
      }
      return;
    }

    if (this.state === "closed") {
      this.failureCount = 0;
    }
  }

  /** Record a failed operation. Trips to open if failure threshold is reached. */
  recordFailure(): void {
    this._checkCooldown();

    if (this.state === "open") return;

    this.failureCount += 1;

    if (this.failureCount >= this.failureThreshold) {
      this.trip();
    }
  }

  /** Manually trip the circuit to open state. */
  trip(): void {
    if (this.state === "open") return;
    const prev = this.state;
    this.state = "open";
    this.openedAt = Date.now();
    this.successCount = 0;
    this.onStateChange?.(prev, "open");
  }

  /** Manually reset the circuit to closed state. */
  reset(): void {
    const prev = this.state;
    this.state = "closed";
    this.failureCount = 0;
    this.successCount = 0;
    this.openedAt = null;
    if (prev !== "closed") {
      this.onStateChange?.(prev, "closed");
    }
  }

  /** Returns a snapshot of internal counters for observability. */
  stats(): {
    state: CircuitBreakerState;
    failureCount: number;
    successCount: number;
    openedAt: number | null;
  } {
    this._checkCooldown();
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      openedAt: this.openedAt,
    };
  }

  /** Transition from open to halfOpen once cooldown has elapsed. */
  private _checkCooldown(): void {
    if (
      this.state === "open" &&
      this.openedAt !== null &&
      Date.now() - this.openedAt >= this.cooldownMs
    ) {
      const prev = this.state;
      this.state = "halfOpen";
      this.successCount = 0;
      this.onStateChange?.(prev, "halfOpen");
    }
  }
}
