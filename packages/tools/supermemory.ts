/**
 * A high-performance in-memory storage engine optimized for speed and scalability.
 * Provides a functional API for managing key-value pairs.
 */
export class Memory {
  private store: Map<string, any>;

  /**
   * Creates a new Memory instance.
   */
  constructor() {
    this.store = new Map();
  }

  /**
   * Sets a value in memory.
   * @param key - The key to store under.
   * @param value - The value to store.
   */
  set(key: string, value: any): void {
    this.store.set(key, value);
  }

  /**
   * Gets a value from memory.
   * @param key - The key to retrieve.
   * @returns The value or undefined if not found.
   */
  get(key: string): any | undefined {
    return this.store.get(key);
  }

  /**
   * Deletes a value from memory.
   * @param key - The key to delete.
   */
  delete(key: string): void {
    this.store.delete(key);
  }

  /**
   * Clears all stored values.
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * Returns the number of items stored.
   * @returns The size of the memory store.
   */
  size(): number {
    return this.store.size;
  }

  /**
   * Returns an iterator for all keys.
   * @returns An iterator of keys.
   */
  keys(): IterableIterator<string> {
    return this.store.keys();
  }

  /**
   * Returns an iterator for all values.
   * @returns An iterator of values.
   */
  values(): IterableIterator<any> {
    return this.store.values();
  }

  /**
   * Returns an iterator for all key-value pairs.
   * @returns An iterator of [key, value] pairs.
   */
  entries(): IterableIterator<[string, any]> {
    return this.store.entries();
  }
}