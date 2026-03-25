/**
 * content-hasher.ts
 * Content-addressable hashing for deduplication and caching.
 * Supports SHA256/MD5 of strings and buffers, file hashing,
 * directory hash trees, and streaming hash computation.
 */

import { createHash, type BinaryToTextEncoding } from "crypto";
import { createReadStream, readdirSync, statSync } from "fs";
import { join } from "path";

export type HashAlgo = "sha256" | "md5" | "sha1" | "sha512";

export interface HashResult {
  hash: string;
  algo: HashAlgo;
  size: number;
}

export interface DirHashTree {
  path: string;
  hash: string;
  children?: DirHashTree[];
  isFile: boolean;
  size: number;
}

export function contentHash(
  data: string | Buffer,
  algo: HashAlgo = "sha256",
  encoding: BinaryToTextEncoding = "hex"
): HashResult {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const hash = createHash(algo).update(buf).digest(encoding);
  return { hash, algo, size: buf.byteLength };
}

export function storageKey(
  data: string | Buffer,
  algo: HashAlgo = "sha256"
): string {
  const { hash } = contentHash(data, algo);
  return `${algo}:${hash}`;
}

export function hashFile(
  path: string,
  algo: HashAlgo = "sha256"
): Promise<HashResult> {
  return new Promise((resolve, reject) => {
    const hasher = createHash(algo);
    let size = 0;
    const stream = createReadStream(path);
    stream.on("data", (chunk: Buffer) => { size += chunk.byteLength; hasher.update(chunk); });
    stream.on("end", () => { resolve({ hash: hasher.digest("hex"), algo, size }); });
    stream.on("error", reject);
  });
}

export async function hashDir(
  dirPath: string,
  algo: HashAlgo = "sha256"
): Promise<DirHashTree> {
  const stat = statSync(dirPath);
  if (stat.isFile()) {
    const result = await hashFile(dirPath, algo);
    return { path: dirPath, hash: result.hash, isFile: true, size: result.size };
  }
  const entries = readdirSync(dirPath).sort();
  const children: DirHashTree[] = [];
  let totalSize = 0;
  for (const entry of entries) {
    const child = await hashDir(join(dirPath, entry), algo);
    children.push(child);
    totalSize += child.size;
  }
  const combined = children.map((c) => c.hash).join("");
  const { hash } = contentHash(combined, algo);
  return { path: dirPath, hash, children, isFile: false, size: totalSize };
}

export function flattenHashTree(tree: DirHashTree): Record<string, string> {
  const result: Record<string, string> = {};
  function walk(node: DirHashTree) {
    result[node.path] = node.hash;
    if (node.children) for (const child of node.children) walk(child);
  }
  walk(tree);
  return result;
}

export function diffHashTrees(
  before: Record<string, string>,
  after: Record<string, string>
): { added: string[]; removed: string[]; changed: string[] } {
  const allPaths = new Set([...Object.keys(before), ...Object.keys(after)]);
  const added: string[] = [], removed: string[] = [], changed: string[] = [];
  for (const path of allPaths) {
    if (!(path in before)) added.push(path);
    else if (!(path in after)) removed.push(path);
    else if (before[path] !== after[path]) changed.push(path);
  }
  return { added, removed, changed };
}
