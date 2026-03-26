import * as crypto from 'crypto';

const allowedAlgorithms = new Set(['md5', 'sha1', 'sha256', 'sha512']);

/**
 * Hash a buffer using the specified algorithm.
 * @param buffer - The buffer to hash.
 * @param algorithm - The hashing algorithm (md5, sha1, sha256, sha512).
 * @returns Hex digest of the hash.
 */
function hashBuffer(buffer: Buffer, algorithm: string): string {
  if (!allowedAlgorithms.has(algorithm)) {
    throw new Error(`Unsupported algorithm: ${algorithm}`);
  }
  return crypto.createHash(algorithm).update(buffer).digest('hex');
}

/**
 * Hash a string using the specified algorithm.
 * @param str - The string to hash.
 * @param algorithm - The hashing algorithm (md5, sha1, sha256, sha512).
 * @returns Hex digest of the hash.
 */
function hashString(str: string, algorithm: string): string {
  return hashBuffer(Buffer.from(str, 'utf8'), algorithm);
}

/**
 * Timing-safe comparison of two hash digests.
 * @param hash1 - First hex digest.
 * @param hash2 - Second hex digest.
 * @returns True if the hashes are equal, false otherwise.
 */
function compare(hash1: string, hash2: string): boolean {
  const buf1 = Buffer.from(hash1, 'hex');
  const buf2 = Buffer.from(hash2, 'hex');
  return crypto.timingSafeEqual(buf1, buf2) === 0;
}

export { hashBuffer, hashString, compare };