/**
 * Represents a structured log entry.
 */
type LogEntry = {
  level: string;
  message: string;
};

/**
 * Aggregates log entries with a level threshold.
 */
export class LogAggregator {
  private buffer: LogEntry[] = [];
  private levelThreshold: string;

  /**
   * Creates a new LogAggregator with the specified level threshold.
   * @param levelThreshold - The minimum log level to consider.
   */
  constructor(levelThreshold: string) {
    this.levelThreshold = levelThreshold;
  }

  /**
   * Adds a log entry to the buffer.
   * @param entry - The log entry to add.
   */
  add(entry: LogEntry): void {
    this.buffer.push(entry);
  }

  /**
   * Returns and clears the buffered log entries.
   * @returns The buffered log entries.
   */
  flush(): LogEntry[] {
    const entries = [...this.buffer];
    this.buffer = [];
    return entries;
  }

  /**
   * Filters buffered log entries by level.
   * @param level - The minimum level to include.
   * @returns Log entries at or above the specified level.
   */
  filter(level: string): LogEntry[] {
    return this.buffer.filter(entry => entry.level >= level);
  }
}

/**
 * Formats log entries as plain text lines.
 * @param entries - The log entries to format.
 * @returns A string with each line representing a log entry.
 */
export function toText(entries: LogEntry[]): string {
  return entries.map(entry => `[${entry.level}] ${entry.message}`).join('\n');
}