/**
 * Detects path traversal attack patterns in input strings.
 * @param input - The input string to check.
 * @returns Object with vulnerability status and found patterns.
 */
export function detect(input: string): { vulnerable: boolean; patterns: string[] } {
  const patterns = input.match(/(\.\.\/|\.\\|%2e%2e%2f|%2e%2e%5c)/gi) || [];
  return { vulnerable: patterns.length > 0, patterns };
}

/**
 * Normalizes a path by resolving and canonicalizing it.
 * @param path - The path to normalize.
 * @returns The normalized path.
 */
export function normalize(path: string): string {
  let parts = path.replace(/\\/g, '/').split('/');
  let result: string[] = [];
  for (let part of parts) {
    if (part === '..') {
      result.pop();
    } else if (part !== '.' && part !== '') {
      result.push(part);
    }
  }
  return '/' + result.join('/');
}

/**
 * Checks if filePath is within basePath after normalization.
 * @param basePath - The base path to compare against.
 * @param filePath - The file path to check.
 * @returns True if filePath is within basePath.
 */
export function isWithinBase(basePath: string, filePath: string): boolean {
  const normalizedBase = normalize(basePath);
  const normalizedFile = normalize(filePath);
  return normalizedFile.startsWith(normalizedBase);
}

/**
 * Scans multiple inputs for path traversal patterns.
 * @param inputs - Object with string values to scan.
 * @returns Object with per-field scan results.
 */
export function scan(inputs: { [key: string]: string }): { [key: string]: { vulnerable: boolean; patterns: string[] } } {
  const results: { [key: string]: { vulnerable: boolean; patterns: string[] } } = {};
  for (const [key, value] of Object.entries(inputs)) {
    results[key] = detect(value);
  }
  return results;
}