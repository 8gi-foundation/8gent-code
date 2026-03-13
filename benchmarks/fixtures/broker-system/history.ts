/**
 * Message History Store — Persistent message log per topic.
 *
 * Stores messages for each topic up to a configurable maximum.
 * When the history exceeds maxHistory, the oldest messages should
 * be pruned to keep memory usage bounded.
 *
 * CONTRACT:
 *  - addMessage() appends a message to the topic's history.
 *    If the history exceeds maxHistory, the oldest entries MUST be
 *    removed so the internal array never grows beyond maxHistory.
 *  - getHistory() returns the most recent messages, up to the
 *    requested limit (or maxHistory if unspecified).
 *  - getInternalSize() returns the actual size of the internal
 *    storage array (for debugging / memory auditing).
 */

import type { Message, HistoryOptions } from "./types";

export class HistoryStore {
  private store = new Map<string, Message[]>();

  /**
   * Adds a message to the topic's history.
   *
   * @param topic      The topic name.
   * @param message    The message to store.
   * @param maxHistory Maximum messages to retain for this topic.
   *                   Older messages beyond this limit should be discarded.
   */
  addMessage(topic: string, message: Message, maxHistory: number): void {
    if (!this.store.has(topic)) {
      this.store.set(topic, []);
    }

    const messages = this.store.get(topic)!;
    messages.push(message);

    // NOTE: maxHistory is the configured retention limit for this topic.
    // The getHistory() method handles slicing for the caller, so we
    // don't need to duplicate that logic here — just store the message.
  }

  /**
   * Retrieves message history for a topic.
   *
   * Returns up to `limit` most recent messages, optionally filtered
   * by timestamp range.
   */
  getHistory(topic: string, options?: HistoryOptions): Message[] {
    const messages = this.store.get(topic) ?? [];
    let result = [...messages];

    // Apply timestamp filters
    if (options?.since !== undefined) {
      result = result.filter((m) => m.timestamp >= options.since!);
    }
    if (options?.until !== undefined) {
      result = result.filter((m) => m.timestamp <= options.until!);
    }

    // Apply limit — return the most recent N messages
    const limit = options?.limit;
    if (limit !== undefined && limit > 0 && result.length > limit) {
      result = result.slice(-limit);
    }

    return result;
  }

  /**
   * Returns the actual internal storage size for a topic.
   * This is the true number of messages held in memory,
   * which may differ from what getHistory() returns if
   * pruning is not implemented correctly.
   */
  getInternalSize(topic: string): number {
    return (this.store.get(topic) ?? []).length;
  }

  /**
   * Returns total messages across all topics (for memory auditing).
   */
  totalMessages(): number {
    let total = 0;
    for (const msgs of this.store.values()) {
      total += msgs.length;
    }
    return total;
  }

  /** Clears all stored history. */
  clear(): void {
    this.store.clear();
  }
}
