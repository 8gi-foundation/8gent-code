/**
 * PathMatcher - matches file paths against include/exclude patterns.
 * Supports glob (*, **, ?), exact, and regex patterns.
 * Zero runtime dependencies.
 */

export type PatternType = "glob" | "exact" | "regex";

export interface Pattern {
  raw: string;
  type: PatternType;
  regex: RegExp;
}

function globToRegex(glob: string): RegExp {
  // Escape regex metacharacters except * and ?
  let re = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    // ** matches any path segment including slashes
    .replace(/\*\*/g, "__DOUBLE_STAR__")
    // * matches anything except slash
    .replace(/\*/g, "[^/]*")
    // ? matches any single character except slash
    .replace(/\?/g, "[^/]")
    .replace(/__DOUBLE_STAR__/g, ".*");

  return new RegExp(`^${re}$`);
}

function compilePattern(raw: string): Pattern {
  // Detect regex: wrapped in / /
  if (raw.startsWith("/") && raw.lastIndexOf("/") > 0) {
    const lastSlash = raw.lastIndexOf("/");
    const flags = raw.slice(lastSlash + 1);
    const body = raw.slice(1, lastSlash);
    return { raw, type: "regex", regex: new RegExp(body, flags) };
  }

  // Detect glob: contains *, **, or ?
  if (raw.includes("*") || raw.includes("?")) {
    return { raw, type: "glob", regex: globToRegex(raw) };
  }

  // Exact match
  return {
    raw,
    type: "exact",
    regex: new RegExp(`^${raw.replace(/[.+^${}()|[\]\\]/g, "\\$&")}$`),
  };
}

function normalizePath(p: string): string {
  // Strip leading ./ and normalize multiple slashes
  return p.replace(/^\.\//, "").replace(/\/+/g, "/");
}

export class PathMatcher {
  private includePatterns: Pattern[] = [];
  private excludePatterns: Pattern[] = [];

  /**
   * Add include patterns. A path must match at least one include pattern
   * (if any are set) to pass. If no include patterns are set, all paths pass
   * the include check.
   */
  include(patterns: string | string[]): this {
    const list = Array.isArray(patterns) ? patterns : [patterns];
    for (const p of list) {
      this.includePatterns.push(compilePattern(p));
    }
    return this;
  }

  /**
   * Add exclude patterns. A path matching any exclude pattern is rejected,
   * even if it matched an include pattern.
   */
  exclude(patterns: string | string[]): this {
    const list = Array.isArray(patterns) ? patterns : [patterns];
    for (const p of list) {
      this.excludePatterns.push(compilePattern(p));
    }
    return this;
  }

  /**
   * Test a single path. Returns true if the path passes include/exclude rules.
   */
  test(path: string): boolean {
    const normalized = normalizePath(path);

    // Exclude check - any match rejects
    for (const pat of this.excludePatterns) {
      if (pat.regex.test(normalized)) return false;
    }

    // Include check - must match at least one if include patterns are set
    if (this.includePatterns.length === 0) return true;
    for (const pat of this.includePatterns) {
      if (pat.regex.test(normalized)) return true;
    }

    return false;
  }

  /**
   * Filter an array of paths, returning only those that pass include/exclude rules.
   */
  filter(paths: string[]): string[] {
    return paths.filter((p) => this.test(p));
  }

  /** Return compiled include patterns (read-only snapshot). */
  getIncludePatterns(): Readonly<Pattern[]> {
    return this.includePatterns;
  }

  /** Return compiled exclude patterns (read-only snapshot). */
  getExcludePatterns(): Readonly<Pattern[]> {
    return this.excludePatterns;
  }
}

/**
 * Convenience function - test a single path against include/exclude pattern lists.
 *
 * @param path     - The file path to test.
 * @param include  - Patterns the path must match (empty = match all).
 * @param exclude  - Patterns that reject the path.
 */
export function matchPath(
  path: string,
  include: string[] = [],
  exclude: string[] = []
): boolean {
  return new PathMatcher().include(include).exclude(exclude).test(path);
}
