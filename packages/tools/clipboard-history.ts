/**
 * ClipboardHistory - searchable clipboard history ring buffer
 * Self-contained, no external dependencies.
 */

export interface ClipboardEntry {
  id: string;
  content: string;
  timestamp: number;
  hash: string;
}

export interface ClipboardHistoryOptions {
  maxSize?: number;
}

function simpleHash(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

function generateId(): string {
  return `clip_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export class ClipboardHistory {
  private entries: ClipboardEntry[] = [];
  private maxSize: number;
  private seenHashes: Set<string> = new Set();

  constructor(options: ClipboardHistoryOptions = {}) {
    this.maxSize = options.maxSize ?? 100;
  }

  /**
   * Push a new entry. Deduplicates by content hash.
   * Returns the entry id, or null if duplicate was silently dropped.
   */
  push(content: string): string | null {
    if (!content || content.trim() === "") return null;

    const hash = simpleHash(content);

    // Deduplication: if identical content already in ring, move it to front
    if (this.seenHashes.has(hash)) {
      const existingIdx = this.entries.findIndex((e) => e.hash === hash);
      if (existingIdx !== -1) {
        const [existing] = this.entries.splice(existingIdx, 1);
        existing.timestamp = Date.now();
        this.entries.unshift(existing);
        return existing.id;
      }
    }

    const entry: ClipboardEntry = {
      id: generateId(),
      content,
      timestamp: Date.now(),
      hash,
    };

    this.entries.unshift(entry);
    this.seenHashes.add(hash);

    // Evict oldest when over capacity
    if (this.entries.length > this.maxSize) {
      const evicted = this.entries.splice(this.maxSize);
      for (const e of evicted) {
        this.seenHashes.delete(e.hash);
      }
    }

    return entry.id;
  }

  /**
   * Search entries by substring match (case-insensitive).
   * Returns results ordered by most recent first.
   */
  search(query: string): ClipboardEntry[] {
    if (!query) return [...this.entries];
    const lower = query.toLowerCase();
    return this.entries.filter((e) =>
      e.content.toLowerCase().includes(lower)
    );
  }

  /**
   * Return the N most recent entries (default 10).
   */
  recent(n: number = 10): ClipboardEntry[] {
    return this.entries.slice(0, Math.max(0, n));
  }

  /**
   * Retrieve a single entry by id.
   */
  getById(id: string): ClipboardEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  /**
   * Clear all history.
   */
  clear(): void {
    this.entries = [];
    this.seenHashes.clear();
  }

  /**
   * Total number of entries currently stored.
   */
  get size(): number {
    return this.entries.length;
  }
}
