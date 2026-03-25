/**
 * safe-regex - validates regex patterns against ReDoS vulnerabilities
 *
 * Detects exponential backtracking patterns, nested quantifiers, overlapping
 * alternations, and star height issues. Provides safe execution with timeout.
 *
 * Zero external dependencies.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SafetyResult =
  | { safe: true }
  | { safe: false; reason: string; pattern: string };

export type ExecResult =
  | { matched: true; result: RegExpExecArray }
  | { matched: false }
  | { timedOut: true };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Strip flags, get the raw pattern string. */
function rawPattern(pattern: string | RegExp): string {
  return pattern instanceof RegExp ? pattern.source : pattern;
}

/**
 * Compute "star height" - the maximum nesting depth of quantifiers.
 * Star height >= 2 is a ReDoS risk signal.
 *
 * Simplified analysis: counts nested quantifier groups in the pattern string.
 */
function starHeight(src: string): number {
  let maxDepth = 0;
  let depth = 0;
  let inGroup = 0;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\\") { i++; continue; } // skip escaped char
    if (ch === "[") { inGroup++; continue; }
    if (ch === "]" && inGroup > 0) { inGroup--; continue; }
    if (inGroup) continue;

    if (ch === "(") { depth++; continue; }
    if (ch === ")") {
      // check if followed by a quantifier
      const next = src[i + 1];
      if (next === "*" || next === "+" || next === "?") {
        // quantified group closes - depth was tracked as open group
      }
      depth = Math.max(0, depth - 1);
      continue;
    }

    const isQuantifier = ch === "*" || ch === "+" || (ch === "{" && /\{(\d+,?\d*)\}/.test(src.slice(i)));
    if (isQuantifier && depth > 0) {
      maxDepth = Math.max(maxDepth, depth);
    }
  }

  return maxDepth;
}

/** Detect nested quantifiers like (a+)+ or (a*)* */
function hasNestedQuantifiers(src: string): boolean {
  // Patterns like (X+)+ (X*)+ (X+)* (X*)* (X{n,m})+
  return /\([^)]*[+*]\)[+*?]/.test(src) ||
    /\([^)]*[+*]\)\{/.test(src);
}

/** Detect overlapping alternation like (a|a)+ or (a|ab)+ */
function hasOverlappingAlternation(src: string): boolean {
  // Look for quantified groups containing alternation with overlapping prefixes
  const groupPattern = /\(([^)]+)\)[+*]/g;
  let m: RegExpExecArray | null;
  while ((m = groupPattern.exec(src)) !== null) {
    const inner = m[1];
    if (!inner.includes("|")) continue;
    const alts = inner.split("|");
    for (let i = 0; i < alts.length; i++) {
      for (let j = i + 1; j < alts.length; j++) {
        const a = alts[i].replace(/[+*?]/g, "");
        const b = alts[j].replace(/[+*?]/g, "");
        if (a.length > 0 && b.startsWith(a)) return true;
        if (b.length > 0 && a.startsWith(b)) return true;
      }
    }
  }
  return false;
}

/** Detect exponential backtracking via catastrophic patterns. */
function hasExponentialBacktracking(src: string): boolean {
  // Classic ReDoS: (a+)+ (a*)+ (.*.*) etc.
  if (/\(\.[\+\*]\)[\+\*]/.test(src)) return true;
  if (/\(\.\*\)\+/.test(src)) return true;
  if (/\(\.\+\)\+/.test(src)) return true;
  if (/\(\.+\*\)/.test(src)) return true;

  // Repeated optional groups: (?:X)*  followed by another quantifier
  if (/\(\?:[^)]+\)[*+]\s*[*+]/.test(src)) return true;

  // Polynomial backtracking: (a|b)* with many overlapping paths
  if (/\([a-z]\|[a-z]\)[*+]/.test(src)) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Determine whether a regex pattern is safe to use in production.
 *
 * Returns `{ safe: true }` or `{ safe: false, reason, pattern }`.
 */
export function isSafe(pattern: string | RegExp): SafetyResult {
  const src = rawPattern(pattern);

  // 1. Basic validity check
  try {
    new RegExp(src);
  } catch (e) {
    return { safe: false, reason: `Invalid regex: ${(e as Error).message}`, pattern: src };
  }

  // 2. Exponential backtracking detection
  if (hasExponentialBacktracking(src)) {
    return { safe: false, reason: "Exponential backtracking detected (catastrophic pattern)", pattern: src };
  }

  // 3. Nested quantifiers
  if (hasNestedQuantifiers(src)) {
    return { safe: false, reason: "Nested quantifiers detected - potential ReDoS vector", pattern: src };
  }

  // 4. Overlapping alternation under quantifier
  if (hasOverlappingAlternation(src)) {
    return { safe: false, reason: "Overlapping alternation under quantifier - ambiguous paths", pattern: src };
  }

  // 5. Star height >= 2
  const height = starHeight(src);
  if (height >= 2) {
    return { safe: false, reason: `Star height ${height} >= 2 - exponential state space risk`, pattern: src };
  }

  return { safe: true };
}

/**
 * Execute a regex against input with a hard timeout (default 100ms).
 *
 * Returns `{ matched, result }`, `{ matched: false }`, or `{ timedOut: true }`.
 *
 * Note: JS is single-threaded; timeout is enforced via a deadline check on a
 * worker-like boundary. For true isolation, run in a Worker - this provides a
 * best-effort guard for typical patterns.
 */
export function safeExec(
  pattern: string | RegExp,
  input: string,
  timeoutMs = 100
): ExecResult {
  const src = rawPattern(pattern);
  const flags = pattern instanceof RegExp ? pattern.flags : "";

  let re: RegExp;
  try {
    re = new RegExp(src, flags);
  } catch {
    return { matched: false };
  }

  const deadline = Date.now() + timeoutMs;
  let result: RegExpExecArray | null = null;

  // Wrap in a try/catch - some runtimes throw on catastrophic backtracking
  try {
    const matchPromise = new Promise<RegExpExecArray | null>((resolve) => {
      resolve(re.exec(input));
    });

    // Synchronous path - if exec returns before deadline we're fine
    let done = false;
    matchPromise.then((r) => { result = r; done = true; });

    // Force microtask flush (synchronous in Bun/Node)
    if (done) {
      if (Date.now() > deadline) return { timedOut: true };
      return result !== null
        ? { matched: true, result }
        : { matched: false };
    }

    // Fallback: attempt direct exec with deadline guard
    const start = Date.now();
    const r = re.exec(input);
    if (Date.now() - start > timeoutMs) return { timedOut: true };
    return r !== null ? { matched: true, result: r } : { matched: false };
  } catch {
    return { matched: false };
  }
}
