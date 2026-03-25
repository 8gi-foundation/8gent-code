/**
 * String Distance Algorithms
 * Hamming, Damerau-Levenshtein, Jaro-Winkler, and normalized scoring.
 */

/**
 * Hamming distance - counts positions where two equal-length strings differ.
 * Throws if strings have different lengths.
 */
export function hamming(a: string, b: string): number {
  if (a.length !== b.length) {
    throw new Error(`Hamming requires equal-length strings (got ${a.length} and ${b.length})`);
  }
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) distance++;
  }
  return distance;
}

/**
 * Damerau-Levenshtein distance - edit distance with transpositions.
 * Counts insertions, deletions, substitutions, and adjacent transpositions.
 */
export function damerauLevenshtein(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;

  if (la === 0) return lb;
  if (lb === 0) return la;

  // dp[i][j] = distance between a[0..i-1] and b[0..j-1]
  const dp: number[][] = Array.from({ length: la + 1 }, (_, i) =>
    Array.from({ length: lb + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );

  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,       // deletion
        dp[i][j - 1] + 1,       // insertion
        dp[i - 1][j - 1] + cost // substitution
      );
      // transposition
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + cost);
      }
    }
  }

  return dp[la][lb];
}

/**
 * Jaro similarity between two strings. Range [0, 1] where 1 = identical.
 */
function jaro(a: string, b: string): number {
  if (a === b) return 1;
  const la = a.length;
  const lb = b.length;
  if (la === 0 || lb === 0) return 0;

  const matchWindow = Math.floor(Math.max(la, lb) / 2) - 1;
  const aMatched = new Uint8Array(la);
  const bMatched = new Uint8Array(lb);

  let matches = 0;
  for (let i = 0; i < la; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, lb);
    for (let j = start; j < end; j++) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = 1;
      bMatched[j] = 1;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < la; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }

  return (matches / la + matches / lb + (matches - transpositions / 2) / matches) / 3;
}

/**
 * Jaro-Winkler similarity. Boosts score for strings sharing a common prefix.
 * Range [0, 1] where 1 = identical.
 */
export function jaroWinkler(a: string, b: string, prefixScale = 0.1): number {
  const jaroScore = jaro(a, b);
  const maxPrefix = Math.min(4, Math.min(a.length, b.length));
  let prefixLen = 0;
  for (let i = 0; i < maxPrefix; i++) {
    if (a[i] === b[i]) prefixLen++;
    else break;
  }
  return jaroScore + prefixLen * prefixScale * (1 - jaroScore);
}

export type DistanceAlgorithm = "hamming" | "damerau-levenshtein" | "jaro-winkler";

/**
 * Normalized distance in [0, 1] where 0 = identical, 1 = maximally different.
 * - hamming: distance / length (requires equal-length strings)
 * - damerau-levenshtein: distance / max(len(a), len(b))
 * - jaro-winkler: 1 - similarity
 */
export function normalizedDistance(
  a: string,
  b: string,
  algorithm: DistanceAlgorithm = "damerau-levenshtein"
): number {
  switch (algorithm) {
    case "hamming": {
      if (a.length !== b.length) {
        throw new Error("Hamming normalized distance requires equal-length strings");
      }
      return a.length === 0 ? 0 : hamming(a, b) / a.length;
    }
    case "damerau-levenshtein": {
      const maxLen = Math.max(a.length, b.length);
      return maxLen === 0 ? 0 : damerauLevenshtein(a, b) / maxLen;
    }
    case "jaro-winkler": {
      return 1 - jaroWinkler(a, b);
    }
  }
}
