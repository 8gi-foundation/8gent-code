/**
 * A sliding window memory for agent conversation context.
 */
export class AgentMemoryWindow<T> {
  /**
   * Creates an instance of AgentMemoryWindow.
   * @param windowSize The maximum number of turns to keep in the window.
   * @param summarize A function to generate a summary of a turn.
   */
  constructor(
    public windowSize: number,
    public summarize: (turn: T) => string
  ) {
    this.window = [];
    this.lastEvictedSummary = null;
  }

  private window: T[];
  private lastEvictedSummary: string | null;

  /**
   * Adds a new turn to the window. Evicts the oldest turn if the window is full.
   * @param turn The new turn to add.
   */
  add(turn: T): void {
    if (this.window.length >= this.windowSize) {
      const evicted = this.window.shift();
      if (evicted !== undefined) {
        this.lastEvictedSummary = this.summarize(evicted);
      }
    }
    this.window.push(turn);
  }

  /**
   * Returns the summary of the last evicted turn.
   * @returns The summary string or null if no eviction has occurred.
   */
  getSummary(): string | null {
    return this.lastEvictedSummary;
  }

  /**
   * Returns the current visible turns in the window.
   * @returns An array of turns.
   */
  getWindow(): T[] {
    return this.window;
  }
}