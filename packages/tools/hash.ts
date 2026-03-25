/**
 * hash.ts - Cryptographic hash utilities for 8gent
 *
 * SHA-256, SHA-512, MD5, file hashing, content-addressable IDs,
 * HMAC, and a consistent hash ring. Uses Bun's built-in crypto.
 *
 * No external dependencies. All functions exported.
 */

import { createHash, createHmac } from "crypto";
import { readFile } from "fs/promises";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HashAlgorithm = "sha256" | "sha512" | "md5";
export type DigestEncoding = "hex" | "base64" | "base64url";

export interface HashResult {
  algorithm: HashAlgorithm;
  digest: string;
  encoding: DigestEncoding;
  byteLength: number;
}

export interface FileHashResult extends HashResult {
  path: string;
  sizeBytes: number;
}

export interface HmacResult {
  algorithm: HashAlgorithm;
  digest: string;
  encoding: DigestEncoding;
}

export interface ConsistentHashRing<T = string> {
  add(node: T): void;
  remove(node: T): void;
  get(key: string): T | null;
  nodes(): T[];
}

// ---------------------------------------------------------------------------
// Core hash primitives
// ---------------------------------------------------------------------------

/**
 * Hash a string or Buffer with the given algorithm.
 */
export function hash(
  data: string | Buffer,
  algorithm: HashAlgorithm = "sha256",
  encoding: DigestEncoding = "hex"
): HashResult {
  const h = createHash(algorithm);
  h.update(data);
  const digest = h.digest(encoding);
  const byteLength = algorithm === "md5" ? 16 : algorithm === "sha256" ? 32 : 64;
  return { algorithm, digest, encoding, byteLength };
}

/**
 * SHA-256 hex digest of a string or Buffer.
 */
export function sha256(data: string | Buffer, encoding: DigestEncoding = "hex"): string {
  return hash(data, "sha256", encoding).digest;
}

/**
 * SHA-512 hex digest of a string or Buffer.
 */
export function sha512(data: string | Buffer, encoding: DigestEncoding = "hex"): string {
  return hash(data, "sha512", encoding).digest;
}

/**
 * MD5 hex digest of a string or Buffer.
 * Note: MD5 is NOT cryptographically secure. Use for checksums only.
 */
export function md5(data: string | Buffer, encoding: DigestEncoding = "hex"): string {
  return hash(data, "md5", encoding).digest;
}

// ---------------------------------------------------------------------------
// File hashing
// ---------------------------------------------------------------------------

/**
 * Hash a file at the given path. Reads the entire file into memory.
 */
export async function hashFile(
  filePath: string,
  algorithm: HashAlgorithm = "sha256",
  encoding: DigestEncoding = "hex"
): Promise<FileHashResult> {
  const buf = await readFile(filePath);
  const h = createHash(algorithm);
  h.update(buf);
  const digest = h.digest(encoding);
  const byteLength = algorithm === "md5" ? 16 : algorithm === "sha256" ? 32 : 64;
  return {
    algorithm,
    digest,
    encoding,
    byteLength,
    path: filePath,
    sizeBytes: buf.byteLength,
  };
}

/**
 * Hash multiple files in parallel. Returns a map of path -> HashResult.
 */
export async function hashFiles(
  filePaths: string[],
  algorithm: HashAlgorithm = "sha256",
  encoding: DigestEncoding = "hex"
): Promise<Map<string, FileHashResult>> {
  const results = await Promise.all(
    filePaths.map((p) => hashFile(p, algorithm, encoding))
  );
  return new Map(results.map((r) => [r.path, r]));
}

// ---------------------------------------------------------------------------
// Content-addressable IDs
// ---------------------------------------------------------------------------

/**
 * Generate a content-addressable ID for arbitrary data.
 * Format: <algorithm>:<digest>
 * Example: sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
 */
export function contentId(
  data: string | Buffer | object,
  algorithm: HashAlgorithm = "sha256"
): string {
  const payload =
    typeof data === "object" && !Buffer.isBuffer(data)
      ? JSON.stringify(data)
      : (data as string | Buffer);
  const digest = hash(payload, algorithm, "hex").digest;
  return `${algorithm}:${digest}`;
}

/**
 * Parse a content ID string into its parts.
 * Returns null if the format is invalid.
 */
export function parseContentId(
  id: string
): { algorithm: string; digest: string } | null {
  const idx = id.indexOf(":");
  if (idx === -1) return null;
  return { algorithm: id.slice(0, idx), digest: id.slice(idx + 1) };
}

/**
 * Verify that data matches a given content ID.
 */
export function verifyContentId(
  data: string | Buffer | object,
  id: string
): boolean {
  const parsed = parseContentId(id);
  if (!parsed) return false;
  const expected = contentId(data, parsed.algorithm as HashAlgorithm);
  return expected === id;
}

// ---------------------------------------------------------------------------
// HMAC
// ---------------------------------------------------------------------------

/**
 * Compute an HMAC for data using the given secret and algorithm.
 */
export function hmac(
  data: string | Buffer,
  secret: string | Buffer,
  algorithm: HashAlgorithm = "sha256",
  encoding: DigestEncoding = "hex"
): HmacResult {
  const h = createHmac(algorithm, secret);
  h.update(data);
  const digest = h.digest(encoding);
  return { algorithm, digest, encoding };
}

/**
 * Verify an HMAC in constant time to prevent timing attacks.
 */
export function verifyHmac(
  data: string | Buffer,
  secret: string | Buffer,
  expectedDigest: string,
  algorithm: HashAlgorithm = "sha256",
  encoding: DigestEncoding = "hex"
): boolean {
  const result = hmac(data, secret, algorithm, encoding);
  const a = Buffer.from(result.digest);
  const b = Buffer.from(expectedDigest);
  if (a.length !== b.length) return false;
  // timingSafeEqual available in Node/Bun crypto
  const { timingSafeEqual } = require("crypto");
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Consistent hash ring
// ---------------------------------------------------------------------------

/**
 * Create a consistent hash ring with virtual nodes for even distribution.
 *
 * @param replicationFactor - Number of virtual nodes per real node (default 150)
 */
export function createHashRing<T = string>(
  replicationFactor = 150
): ConsistentHashRing<T> {
  // Sorted array of { point, node } entries
  const ring: Array<{ point: number; node: T }> = [];
  const nodeSet = new Set<T>();

  function keyFor(node: T, replica: number): string {
    return `${String(node)}#${replica}`;
  }

  function pointFor(key: string): number {
    const h = createHash("sha256");
    h.update(key);
    const buf = h.digest();
    // Use first 4 bytes as uint32 for a 0..2^32-1 range
    return buf.readUInt32BE(0);
  }

  function insertSorted(entry: { point: number; node: T }): void {
    let lo = 0;
    let hi = ring.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (ring[mid].point < entry.point) lo = mid + 1;
      else hi = mid;
    }
    ring.splice(lo, 0, entry);
  }

  return {
    add(node: T): void {
      if (nodeSet.has(node)) return;
      nodeSet.add(node);
      for (let i = 0; i < replicationFactor; i++) {
        insertSorted({ point: pointFor(keyFor(node, i)), node });
      }
    },

    remove(node: T): void {
      if (!nodeSet.has(node)) return;
      nodeSet.delete(node);
      for (let i = ring.length - 1; i >= 0; i--) {
        if (ring[i].node === node) ring.splice(i, 1);
      }
    },

    get(key: string): T | null {
      if (ring.length === 0) return null;
      const point = pointFor(key);
      // Binary search for first ring entry >= point
      let lo = 0;
      let hi = ring.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (ring[mid].point < point) lo = mid + 1;
        else hi = mid;
      }
      // Wrap around
      const idx = lo < ring.length ? lo : 0;
      return ring[idx].node;
    },

    nodes(): T[] {
      return Array.from(nodeSet);
    },
  };
}

// ---------------------------------------------------------------------------
// CLI entrypoint (bun packages/tools/hash.ts <command> ...)
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case "sha256": {
      const input = args.join(" ");
      console.log(sha256(input));
      break;
    }
    case "sha512": {
      const input = args.join(" ");
      console.log(sha512(input));
      break;
    }
    case "md5": {
      const input = args.join(" ");
      console.log(md5(input));
      break;
    }
    case "file": {
      const [filePath, algo = "sha256"] = args;
      if (!filePath) { console.error("Usage: hash.ts file <path> [algo]"); process.exit(1); }
      hashFile(filePath, algo as HashAlgorithm).then((r) => {
        console.log(`${r.algorithm}:${r.digest}  ${r.path} (${r.sizeBytes} bytes)`);
      });
      break;
    }
    case "cid": {
      const input = args.join(" ");
      console.log(contentId(input));
      break;
    }
    case "hmac": {
      const [secret, ...rest] = args;
      const data = rest.join(" ");
      if (!secret || !data) { console.error("Usage: hash.ts hmac <secret> <data>"); process.exit(1); }
      console.log(hmac(data, secret).digest);
      break;
    }
    default:
      console.log(`Usage: bun packages/tools/hash.ts <command> [args]

Commands:
  sha256 <text>            SHA-256 hex of text
  sha512 <text>            SHA-512 hex of text
  md5 <text>               MD5 hex of text (checksums only)
  file <path> [algo]       Hash a file (default: sha256)
  cid <text>               Content-addressable ID
  hmac <secret> <data>     HMAC-SHA256 hex
`);
  }
}
