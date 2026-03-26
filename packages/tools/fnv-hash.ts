/**
 * Compute FNV-1a 32-bit hash
 * @param data - input data
 * @returns 32-bit hash as number
 */
export function fnv1a32(data: string | Uint8Array): number {
  let hash = 0x811c9dc5;
  const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data);
  for (const byte of bytes) {
    hash ^= byte;
    hash = (hash >>> 0) * 0x1000193;
  }
  return hash;
}

/**
 * Compute FNV-1a 64-bit hash
 * @param data - input data
 * @returns 64-bit hash as bigint
 */
export function fnv1a64(data: string | Uint8Array): bigint {
  let hash = 0xcbf29ce489991eb8n;
  const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash *= 0x100000001b3n;
  }
  return hash;
}

/**
 * Compute FNV-1a 128-bit hash
 * @param data - input data
 * @returns 128-bit hash as hex string
 */
export function fnv1a128(data: string | Uint8Array): string {
  let hash = 0x64466423636261606f6e696867666564n;
  const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash *= 0x10000000100000001b3n;
  }
  return hash.toString(16).padStart(32, '0');
}

/**
 * Streaming FNV-1a hasher
 */
export class FNV {
  private hash: number = 0x811c9dc5;

  /**
   * Update the hasher with a chunk of data
   * @param chunk - data chunk
   */
  update(chunk: string | Uint8Array): void {
    const bytes = chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(chunk);
    for (const byte of bytes) {
      this.hash ^= byte;
      this.hash = (this.hash >>> 0) * 0x1000193;
    }
  }

  /**
   * Get the current hash value
   * @returns 32-bit hash as number
   */
  digest(): number {
    return this.hash;
  }
}