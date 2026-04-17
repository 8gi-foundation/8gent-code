/**
 * fuzzy-match.ts
 * Fuzzy string matching using Levenshtein distance with scored ranking.
 * No external dependencies. ~120 lines.
 */

export interface FuzzyMatchOptions {
  minScore?: number;
  limit?: number;
  caseSensitive?: boolean;
}

export interface FuzzyResult {
  candidate: string;
  score: number;
  distance: number;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  if (a.length > b.length) [a, b] = [b, a];
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: m + 1 }, (_, i) => i);
  let curr = new Array<number>(m + 1);
  for (let j = 1; j <= n; j++) {
    curr[0] = j;
    for (let i = 1; i <= m; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[i] = Math.min(curr[i - 1] + 1, prev[i] + 1, prev[i - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[m];
}

export function score(query: string, candidate: string, caseSensitive = false): number {
  const q = caseSensitive ? query : query.toLowerCase();
  const c = caseSensitive ? candidate : candidate.toLowerCase();
  if (c === q) return 1.0;
  const dist = levenshtein(q, c);
  const maxLen = Math.max(q.length, c.length);
  let s = 1 - dist / maxLen;
  if (c.startsWith(q)) s = Math.min(1, s + 0.15);
  if (c.includes(q)) s = Math.min(1, s + 0.1);
  return Math.max(0, s);
}

export function fuzzyMatch(
  query: string,
  candidates: string[],
  options: FuzzyMatchOptions = {}
): FuzzyResult[] {
  const { minScore = 0.1, limit, caseSensitive = false } = options;
  if (!query || candidates.length === 0) return [];
  const results: FuzzyResult[] = [];
  for (const candidate of candidates) {
    const s = score(query, candidate, caseSensitive);
    if (s >= minScore) {
      const q = caseSensitive ? query : query.toLowerCase();
      const c = caseSensitive ? candidate : candidate.toLowerCase();
      results.push({ candidate, score: s, distance: levenshtein(q, c) });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return limit !== undefined ? results.slice(0, limit) : results;
}
