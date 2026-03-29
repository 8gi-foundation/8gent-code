/**
 * Tool Loop Detector - Circuit breaker for agent tool loops
 *
 * Detects three patterns:
 * 1. REPEAT: same tool+args called 3+ times in a row
 * 2. PING-PONG: alternating between two tools 4+ times
 * 3. GLOBAL: more than N total tool calls in one turn
 *
 * @see https://github.com/8gi-foundation/8gent-code/issues/975
 */

export type LoopType = "repeat" | "ping-pong" | "global";

export interface LoopDetection {
  detected: true;
  type: LoopType;
  message: string;
}

interface ToolCall {
  toolName: string;
  argsHash: string;
}

export interface ToolLoopDetectorConfig {
  /** Number of recent calls to track (default 20) */
  windowSize?: number;
  /** Consecutive identical calls to trigger repeat detection (default 3) */
  repeatThreshold?: number;
  /** Alternating pair count to trigger ping-pong detection (default 4) */
  pingPongThreshold?: number;
  /** Max total tool calls per turn before global limit fires (default 50) */
  globalLimit?: number;
}

export class ToolLoopDetector {
  private history: ToolCall[] = [];
  private totalCalls = 0;
  private windowSize: number;
  private repeatThreshold: number;
  private pingPongThreshold: number;
  private globalLimit: number;

  constructor(config: ToolLoopDetectorConfig = {}) {
    this.windowSize = config.windowSize ?? 20;
    this.repeatThreshold = config.repeatThreshold ?? 3;
    this.pingPongThreshold = config.pingPongThreshold ?? 4;
    this.globalLimit = config.globalLimit ?? 50;
  }

  /**
   * Record a tool call. Call this every time a tool executes.
   */
  record(toolName: string, args: Record<string, unknown>): void {
    const argsHash = JSON.stringify(args);
    this.history.push({ toolName, argsHash });
    this.totalCalls++;

    // Keep only the last N entries
    if (this.history.length > this.windowSize) {
      this.history.shift();
    }
  }

  /**
   * Check for loop patterns. Returns detection info or null if no loop found.
   */
  check(): LoopDetection | null {
    // 1. GLOBAL: too many total calls this turn
    if (this.totalCalls > this.globalLimit) {
      return {
        detected: true,
        type: "global",
        message: `Global tool call limit exceeded: ${this.totalCalls} calls this turn (limit: ${this.globalLimit}). Aborting to prevent runaway execution.`,
      };
    }

    const len = this.history.length;

    // 2. REPEAT: same tool+args N times in a row
    if (len >= this.repeatThreshold) {
      const last = this.history[len - 1];
      let streak = 1;
      for (let i = len - 2; i >= 0; i--) {
        const entry = this.history[i];
        if (entry.toolName === last.toolName && entry.argsHash === last.argsHash) {
          streak++;
        } else {
          break;
        }
      }
      if (streak >= this.repeatThreshold) {
        return {
          detected: true,
          type: "repeat",
          message: `Repeat loop detected: "${last.toolName}" called ${streak} times in a row with identical arguments. Try a different approach.`,
        };
      }
    }

    // 3. PING-PONG: alternating between two tools
    // Need at least pingPongThreshold * 2 entries to detect
    const minEntries = this.pingPongThreshold * 2;
    if (len >= minEntries) {
      const a = this.history[len - 2];
      const b = this.history[len - 1];

      // Only check if the last two are different tools
      if (a.toolName !== b.toolName) {
        let alternations = 1; // We already have one pair (a, b)
        for (let i = len - 3; i >= 0; i -= 2) {
          const prev = this.history[i];
          const prevNext = this.history[i + 1];
          if (
            prev && prevNext &&
            prev.toolName === a.toolName &&
            prevNext.toolName === b.toolName
          ) {
            alternations++;
          } else {
            break;
          }
        }
        if (alternations >= this.pingPongThreshold) {
          return {
            detected: true,
            type: "ping-pong",
            message: `Ping-pong loop detected: alternating between "${a.toolName}" and "${b.toolName}" ${alternations} times. Break the cycle and try a different strategy.`,
          };
        }
      }
    }

    return null;
  }

  /**
   * Reset state. Call at the start of each new turn/message.
   */
  reset(): void {
    this.history = [];
    this.totalCalls = 0;
  }
}
