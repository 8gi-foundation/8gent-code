import * as path from 'path';

/**
 * Checks if the userPath is safe within the root directory.
 * @param userPath - The user-provided path.
 * @param root - The root directory to check against.
 * @returns false if the path escapes the root, otherwise true.
 */
export function isSafe(userPath: string, root: string): boolean {
  const resolved = path.resolve(root, userPath);
  return resolved.startsWith(root);
}

/**
 * Sanitizes the userPath by resolving it against the root.
 * @param userPath - The user-provided path.
 * @param root - The root directory to check against.
 * @returns The resolved path if safe, otherwise throws an error.
 * @throws Error if path traversal is detected.
 */
export function sanitize(userPath: string, root: string): string {
  const resolved = path.resolve(root, userPath);
  if (!isSafe(userPath, root)) {
    throw new Error('Path traversal detected');
  }
  return resolved;
}

/**
 * Detects suspicious patterns in the given path.
 * @param inputPath - The path to analyze.
 * @returns An array of suspicious patterns found.
 */
export function detect(inputPath: string): string[] {
  const patterns = /(^\/|\/\/|\.\.\/|\.\/)/g;
  return inputPath.match(patterns) || [];
}

/**
 * Normalizes the input path by resolving `..`, `.`, and double slashes.
 * @param inputPath - The path to normalize.
 * @returns The normalized path.
 */
export function normalize(inputPath: string): string {
  return path.normalize(inputPath);
}