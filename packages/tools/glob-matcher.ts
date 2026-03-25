/**
 * glob-matcher - zero-dependency glob pattern matching for file paths.
 *
 * Supports: * (any chars except /), ** (recursive), ? (single char),
 * {a,b} brace expansion, !pattern negation.
 */

export function globToRegex(pattern: string): RegExp {
  const expanded = expandBraces(pattern);
  if (expanded.length > 1) {
    const parts = expanded.map((p) => globSegmentToRegexSource(p));
    return new RegExp(`^(?:${parts.join("|")})$`);
  }
  return new RegExp(`^${globSegmentToRegexSource(pattern)}$`);
}

export function globMatch(pattern: string, path: string): boolean {
  const negated = pattern.startsWith("!");
  const core = negated ? pattern.slice(1) : pattern;
  const matches = globToRegex(core).test(normalizePath(path));
  return negated ? !matches : matches;
}

export function globFilter(
  patterns: string | string[],
  paths: string[]
): string[] {
  const list = Array.isArray(patterns) ? patterns : [patterns];
  const positives = list.filter((p) => !p.startsWith("!"));
  const negatives = list.filter((p) => p.startsWith("!"));

  return paths.filter((p) => {
    const np = normalizePath(p);
    const positiveMatch =
      positives.length === 0 ||
      positives.some((pat) => globToRegex(pat).test(np));
    const negativeMatch = negatives.some((pat) =>
      globToRegex(pat.slice(1)).test(np)
    );
    return positiveMatch && !negativeMatch;
  });
}

function normalizePath(p: string): string {
  return p.replace(/^\.\//, "").replace(/\/+/g, "/");
}

function globSegmentToRegexSource(pattern: string): string {
  let src = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        src += ".*";
        i += 2;
        if (pattern[i] === "/") { src += "(?:/|$)"; i++; }
      } else {
        src += "[^/]*";
        i++;
      }
    } else if (ch === "?") {
      src += "[^/]";
      i++;
    } else if (/[.+^$|()\[\]{}\\]/.test(ch)) {
      src += "\\" + ch;
      i++;
    } else {
      src += ch;
      i++;
    }
  }
  return src;
}

function expandBraces(pattern: string): string[] {
  const start = pattern.indexOf("{");
  if (start === -1) return [pattern];
  const end = pattern.indexOf("}", start);
  if (end === -1) return [pattern];
  const prefix = pattern.slice(0, start);
  const suffix = pattern.slice(end + 1);
  const options = pattern.slice(start + 1, end).split(",");
  return options.flatMap((opt) => expandBraces(prefix + opt + suffix));
}
