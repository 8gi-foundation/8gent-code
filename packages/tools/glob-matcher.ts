/**
 * glob-matcher — zero-dependency glob pattern matching for file paths.
 *
 * Supports:
 *   *       any characters except /
 *   **      any characters including /
 *   ?       single character except /
 *   {a,b}   brace expansion (alternation)
 *   !pat    negation (leading ! on a pattern)
 *
 * Exported API:
 *   globToRegex(pattern)          convert a glob to a RegExp
 *   globMatch(pattern, path)      test a single path against a pattern
 *   globFilter(patterns, paths)   filter a path array with one or more patterns
 */

/** Convert a single glob pattern (no negation prefix) to a RegExp. */
export function globToRegex(pattern: string): RegExp {
  // Expand brace expressions before processing the rest
  const expanded = expandBraces(pattern);
  if (expanded.length > 1) {
    const parts = expanded.map((p) => globSegmentToRegexSource(p));
    return new RegExp(`^(?:${parts.join("|")})$`);
  }
  return new RegExp(`^${globSegmentToRegexSource(pattern)}$`);
}

/** Return true if `path` matches `pattern`. */
export function globMatch(pattern: string, path: string): boolean {
  const negated = pattern.startsWith("!");
  const core = negated ? pattern.slice(1) : pattern;
  const matches = globToRegex(core).test(normalizePath(path));
  return negated ? !matches : matches;
}

/**
 * Filter `paths` with one or more patterns.
 *
 * Rules (same as .gitignore / micromatch convention):
 *   - Patterns are evaluated in order.
 *   - A non-negated pattern includes matching paths.
 *   - A negated pattern (!pat) excludes previously included paths.
 *   - If all patterns are negated, paths not matched are included by default.
 */
export function globFilter(
  patterns: string | string[],
  paths: string[]
): string[] {
  const list = Array.isArray(patterns) ? patterns : [patterns];
  const positives = list.filter((p) => !p.startsWith("!"));
  const negatives = list.filter((p) => p.startsWith("!"));

  return paths.filter((p) => {
    const np = normalizePath(p);
    // If there are positive patterns, path must match at least one.
    const positiveMatch =
      positives.length === 0 || positives.some((pat) => globToRegex(pat).test(np));
    // Path must not match any negation pattern.
    const negativeMatch = negatives.some((pat) =>
      globToRegex(pat.slice(1)).test(np)
    );
    return positiveMatch && !negativeMatch;
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Normalise a path: strip leading ./ and collapse duplicate slashes. */
function normalizePath(p: string): string {
  return p.replace(/^\.\//, "").replace(/\/+/g, "/");
}

/**
 * Convert a single (brace-free) glob segment to a regex source string.
 * Handles *, **, ?, and escapes all other regex special characters.
 */
function globSegmentToRegexSource(pattern: string): string {
  let src = "";
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // ** — match anything including slashes
        src += ".*";
        i += 2;
        // Consume an optional surrounding slash so **/ works naturally
        if (pattern[i] === "/") {
          src += "(?:/|$)";
          i++;
        }
      } else {
        // * — match anything except /
        src += "[^/]*";
        i++;
      }
    } else if (ch === "?") {
      src += "[^/]";
      i++;
    } else if (isRegexSpecial(ch)) {
      src += "\\" + ch;
      i++;
    } else {
      src += ch;
      i++;
    }
  }

  return src;
}

const REGEX_SPECIAL = new Set([
  ".",
  "+",
  "^",
  "$",
  "|",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  "\\",
]);

function isRegexSpecial(ch: string): boolean {
  return REGEX_SPECIAL.has(ch);
}

/**
 * Expand brace expressions like {a,b,c} into an array of alternatives.
 * Only handles a single top-level brace pair; nested braces are not supported.
 */
function expandBraces(pattern: string): string[] {
  const start = pattern.indexOf("{");
  if (start === -1) return [pattern];

  const end = pattern.indexOf("}", start);
  if (end === -1) return [pattern]; // malformed — treat as literal

  const prefix = pattern.slice(0, start);
  const suffix = pattern.slice(end + 1);
  const options = pattern.slice(start + 1, end).split(",");

  return options.flatMap((opt) => expandBraces(prefix + opt + suffix));
}
