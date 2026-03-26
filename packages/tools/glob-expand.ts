/**
 * Split a path string into segments.
 * @param str The path string.
 * @returns Array of segments.
 */
function splitPathSegments(str: string): string[] {
  return str.split('/');
}

/**
 * Check if pattern parts match path parts.
 * @param patternParts Pattern segments.
 * @param pathParts Path segments.
 * @returns True if match.
 */
function matchPatternParts(patternParts: string[], pathParts: string[]): boolean {
  let i = 0, j = 0;
  while (i < patternParts.length && j < pathParts.length) {
    const p = patternParts[i];
    const path = pathParts[j];
    if (p === '*') {
      i++;
      j++;
    } else if (p === '?') {
      i++;
      j++;
    } else if (p === '**') {
      for (let k = j; k <= pathParts.length - (patternParts.length - i - 1); k++) {
        if (matchPatternParts(patternParts.slice(i + 1), pathParts.slice(k))) {
          return true;
        }
      }
      return false;
    } else {
      if (p !== path) return false;
      i++;
      j++;
    }
  }
  if (i < patternParts.length) {
    for (let l = i; l < patternParts.length; l++) {
      if (patternParts[l] !== '**') return false;
    }
  }
  return i === patternParts.length && j === pathParts.length;
}

/**
 * Check if a path matches a pattern.
 * @param pattern The glob pattern.
 * @param path The file path.
 * @returns True if match.
 */
function matches(pattern: string, path: string): boolean {
  const patternParts = splitPathSegments(pattern);
  const pathParts = splitPathSegments(path);
  return matchPatternParts(patternParts, pathParts);
}

/**
 * Match paths against a glob pattern.
 * @param pattern The glob pattern.
 * @param paths Array of paths.
 * @returns Matching paths.
 */
export function match(pattern: string, paths: string[]): string[] {
  return paths.filter(path => matches(pattern, path));
}

/**
 * Return paths that do not match a glob pattern.
 * @param pattern The glob pattern.
 * @param paths Array of paths.
 * @returns Non-matching paths.
 */
export function negate(pattern: string, paths: string[]): string[] {
  return paths.filter(path => !matches(pattern, path));
}

/**
 * Check if a string contains glob characters.
 * @param str The string to check.
 * @returns True if contains *, ?, or **.
 */
export function isGlob(str: string): boolean {
  return /[*?]|\\*/.test(str);
}