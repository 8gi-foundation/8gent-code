/**
 * OAuth 2.0 state parameter utility
 */
class StateManager {
  private static storage = new Map<string, { metadata: any; expiresAt: number }>();

  /**
   * Generate a random base64url state string
   */
  public static generate(): string {
    const array = new Uint8Array(16);
    crypto.getRandomValues(array);
    return StateManager.toBase64Url(array.buffer);
  }

  private static toBase64Url(buffer: ArrayBuffer): string {
    const uint8Array = new Uint8Array(buffer);
    let str = '';
    for (let i = 0; i < uint8Array.length; i++) {
      str += String.fromCharCode(uint8Array[i]);
    }
    return btoa(str)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  /**
   * Store state with metadata and TTL
   * @param state - The state string
   * @param metadata - Any metadata to associate with the state
   * @param ttl - Time to live in milliseconds (default 10 minutes)
   */
  public static store(state: string, metadata: any, ttl: number = 600000): void {
    const expiresAt = Date.now() + ttl;
    StateManager.storage.set(state, { metadata, expiresAt });
  }

  /**
   * Consume state, validate and remove, return metadata or null
   * @param state - The state string
   * @returns metadata if valid, else null
   */
  public static consume(state: string): any | null {
    const entry = StateManager.storage.get(state);
    if (!entry) return null;
    if (StateManager.isExpired(state)) {
      StateManager.storage.delete(state);
      return null;
    }
    StateManager.storage.delete(state);
    return entry.metadata;
  }

  /**
   * Check if state is expired
   * @param state - The state string
   * @returns true if expired, else false
   */
  public static isExpired(state: string): boolean {
    const entry = StateManager.storage.get(state);
    return entry ? Date.now() >= entry.expiresAt : true;
  }
}

export { StateManager };