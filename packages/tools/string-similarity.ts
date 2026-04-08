/**
 * String Similarity Scorer
 *
 * Computes similarity between strings using multiple algorithms:
 *   - Jaccard index on character bigrams
 *   - Cosine similarity on character n-gram frequency vectors
 *   - Dice coefficient on character bigrams
 *
 * All scores are in [0, 1] where 1 means identical.
 */

// --- helpers ----------------------------------------------------------------

function bigrams(s: string): string[] {
  const result: string[] = [];
  for (let i = 0; i < s.length - 1; i++) {
    result.push(s.slice(i, i + 2));
  }
  return result;
}

function ngrams(s: string, n: number): string[] {
  const result: string[] = [];
  for (let i = 0; i <= s.length - n; i++) {
    result.push(s.slice(i, i + n));
  }
  return result;
}

function tokenSet(tokens: string[]): Set<string> {
  return new Set(tokens);
}

function tokenFreq(tokens: string[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const t of tokens) {
    freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  return freq;
}

function normalize(s: string): string {
  return s.toLowerCase().trim();
}

// --- algorithms -------------------------------------------------------------

/**
 * Jaccard index on character bigrams.
 * J(A,B) = |A ∩ B| / |A ∪ B|
 */
export function jaccard(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  if (na.length < 2 || nb.length < 2) return na === nb ? 1 : 0;

  const setA = tokenSet(bigrams(na));
  const setB = tokenSet(bigrams(nb));

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Cosine similarity on character n-gram (trigram) frequency vectors.
 * cos(A,B) = (A · B) / (|A| * |B|)
 */
export function cosine(a: string, b: string, n = 3): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  if (na.length < n || nb.length < n) return na === nb ? 1 : 0;

  const freqA = tokenFreq(ngrams(na, n));
  const freqB = tokenFreq(ngrams(nb, n));

  let dot = 0;
  for (const [token, countA] of freqA) {
    const countB = freqB.get(token) ?? 0;
    dot += countA * countB;
  }

  const magA = Math.sqrt([...freqA.values()].reduce((s, c) => s + c * c, 0));
  const magB = Math.sqrt([...freqB.values()].reduce((s, c) => s + c * c, 0));

  return magA === 0 || magB === 0 ? 0 : dot / (magA * magB);
}

/**
 * Dice coefficient on character bigrams.
 * Dice(A,B) = 2 * |A ∩ B| / (|A| + |B|)
 */
export function dice(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  if (na.length < 2 || nb.length < 2) return na === nb ? 1 : 0;

  const biA = bigrams(na);
  const biB = bigrams(nb);
  const setA = tokenSet(biA);
  const setB = tokenSet(biB);

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }

  return (2 * intersection) / (setA.size + setB.size);
}

// --- public API -------------------------------------------------------------

export type Algorithm = "jaccard" | "cosine" | "dice";

/**
 * Compute similarity between two strings.
 * @param a - first string
 * @param b - second string
 * @param algorithm - which algorithm to use (default: "dice")
 * @returns score in [0, 1]
 */
export function similarity(
  a: string,
  b: string,
  algorithm: Algorithm = "dice"
): number {
  switch (algorithm) {
    case "jaccard":
      return jaccard(a, b);
    case "cosine":
      return cosine(a, b);
    case "dice":
      return dice(a, b);
  }
}

export interface BestMatchResult {
  candidate: string;
  score: number;
  index: number;
}

/**
 * Find the best matching candidate for a query string.
 * Uses the average of all three algorithms for a balanced score.
 *
 * @param query - the string to match
 * @param candidates - list of candidate strings
 * @returns best match with score and original index, or null if candidates is empty
 */
export function bestMatch(
  query: string,
  candidates: string[]
): BestMatchResult | null {
  if (candidates.length === 0) return null;

  let best: BestMatchResult = { candidate: candidates[0], score: -1, index: 0 };

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const score =
      (jaccard(query, c) + cosine(query, c) + dice(query, c)) / 3;

    if (score > best.score) {
      best = { candidate: c, score, index: i };
    }
  }

  return best;
}
