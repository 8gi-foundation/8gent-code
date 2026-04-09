/**
 * Normalize a file path by collapsing redundant elements.
 * @param path - The path to normalize.
 * @returns The normalized path.
 */
function normalize(path: string): string {
  const isAbsolute = path.startsWith('/');
  const parts = path.split('/').filter(p => p !== '');
  const resultParts: string[] = [];
  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') {
      resultParts.pop();
    } else {
      resultParts.push(part);
    }
  }
  const result = resultParts.join('/');
  return isAbsolute ? `/${result}` : result;
}

/**
 * Join path segments into a single path.
 * @param segments - The path segments to join.
 * @returns The joined path.
 */
function join(...segments: string[]): string {
  const parts: string[] = [];
  for (const segment of segments) {
    const segParts = segment.split('/').filter(p => p !== '');
    if (segParts.length === 0) continue;
    if (segParts[0] === '') {
      parts.length = 0;
    }
    for (const part of segParts) {
      if (part === '.') continue;
      if (part === '..') {
        parts.pop();
      } else {
        parts.push(part);
      }
    }
  }
  return parts.length === 0 ? '.' : parts.join('/');
}

/**
 * Compute the relative path from 'from' to 'to'.
 * @param from - The base path.
 * @param to - The target path.
 * @returns The relative path.
 */
function relative(from: string, to: string): string {
  const fromParts = from.split('/').filter(p => p !== '');
  const toParts = to.split('/').filter(p => p !== '');
  let i = 0;
  while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) {
    i++;
  }
  const up = fromParts.slice(i).map(() => '..');
  const down = toParts.slice(i);
  return up.concat(down).join('/');
}

/**
 * Check if a path is absolute.
 * @param path - The path to check.
 * @returns True if the path is absolute.
 */
function isAbsolute(path: string): boolean {
  return path.startsWith('/');
}

/**
 * Get the file extension of a path.
 * @param path - The path to check.
 * @returns The file extension without the leading dot.
 */
function ext(path: string): string {
  const lastDot = path.lastIndexOf('.');
  return lastDot === -1 ? '' : path.slice(lastDot + 1);
}

export { normalize, join, relative, isAbsolute, ext };