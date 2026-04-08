/**
 * Key-value scratchpad for agent working memory.
 */
export class Scratchpad {
  private map: Map<string, any>;

  /**
   * Creates a new scratchpad instance.
   */
  constructor() {
    this.map = new Map();
  }

  /**
   * Gets the value associated with the key.
   * @param key The key.
   * @returns The value or undefined if not found.
   */
  get(key: string): any {
    return this.map.get(key);
  }

  /**
   * Sets a key-value pair.
   * @param key The key.
   * @param value The value.
   * @returns This instance for method chaining.
   */
  set(key: string, value: any): this {
    this.map.set(key, value);
    return this;
  }

  /**
   * Deletes a key-value pair.
   * @param key The key.
   * @returns True if the key existed.
   */
  delete(key: string): boolean {
    return this.map.delete(key);
  }

  /**
   * Clears all key-value pairs.
   */
  clear(): void {
    this.map.clear();
  }

  /**
   * Checks if a key exists.
   * @param key The key.
   * @returns True if the key exists.
   */
  has(key: string): boolean {
    return this.map.has(key);
  }

  /**
   * Iterates over keys.
   * @returns Iterator of keys.
   */
  keys(): IterableIterator<string> {
    return this.map.keys();
  }

  /**
   * Iterates over key-value pairs.
   * @returns Iterator of [key, value] pairs.
   */
  entries(): IterableIterator<[string, any]> {
    return this.map.entries();
  }

  /**
   * Serializes scratchpad to LLM-readable string.
   * @returns JSON string representation.
   */
  toContext(): string {
    const obj: Record<string, any> = {};
    for (const [key, value] of this.map) {
      obj[key] = value;
    }
    return JSON.stringify(obj);
  }

  /**
   * Parses scratchpad from string.
   * @param text The serialized string.
   * @returns New scratchpad instance.
   */
  static fromContext(text: string): Scratchpad {
    const obj = JSON.parse(text);
    const scratchpad = new Scratchpad();
    for (const [key, value] of Object.entries(obj)) {
      scratchpad.set(key, value);
    }
    return scratchpad;
  }
}