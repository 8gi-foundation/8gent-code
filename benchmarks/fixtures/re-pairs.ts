/**
 * RE001 — Reverse Engineering: Modified Run-Length Encoding
 *
 * Algorithm: Encode an integer array into [value, descriptor] pairs.
 *
 * Rules (applied greedily left-to-right, longest match wins):
 *   1. Ascending run (each elem = prev + 1, length >= 2):
 *      Encode as [start, length]
 *
 *   2. Descending run (each elem = prev - 1, length >= 2):
 *      Reverse the run, then encode as ascending: [end_value, length]
 *      (end_value is the smallest in the descending sequence)
 *
 *   3. Plateau (consecutive equal values, count >= 2):
 *      Encode as [value, -count]  (negative count distinguishes from runs)
 *
 *   4. Single value (not part of any above pattern):
 *      Encode as [value, 1]
 *
 * Priority when multiple patterns start at same index:
 *   - Take the longest greedy match among ascending, descending, or plateau.
 *   - If only 1 element remains or it doesn't extend any pattern, it's a single.
 *
 * Reference implementation (for pair generation only — NOT shown to LLM):
 */
function encode(input: number[]): number[] {
  const result: number[] = [];
  let i = 0;

  while (i < input.length) {
    // Try ascending run
    let ascLen = 1;
    while (
      i + ascLen < input.length &&
      input[i + ascLen] === input[i + ascLen - 1] + 1
    ) {
      ascLen++;
    }

    // Try descending run
    let descLen = 1;
    while (
      i + descLen < input.length &&
      input[i + descLen] === input[i + descLen - 1] - 1
    ) {
      descLen++;
    }

    // Try plateau
    let platLen = 1;
    while (
      i + platLen < input.length &&
      input[i + platLen] === input[i]
    ) {
      platLen++;
    }

    // Pick the longest pattern (minimum length 2 to qualify)
    const candidates: Array<{ type: string; len: number }> = [];
    if (ascLen >= 2) candidates.push({ type: "asc", len: ascLen });
    if (descLen >= 2) candidates.push({ type: "desc", len: descLen });
    if (platLen >= 2) candidates.push({ type: "plat", len: platLen });

    if (candidates.length === 0) {
      // Single value
      result.push(input[i], 1);
      i++;
      continue;
    }

    // Longest wins; ties broken by priority: asc > desc > plat
    candidates.sort((a, b) => b.len - a.len);
    const best = candidates[0];

    if (best.type === "asc") {
      result.push(input[i], best.len);
      i += best.len;
    } else if (best.type === "desc") {
      // Reverse: smallest value is at the end of the descending run
      const start = input[i + best.len - 1]; // smallest value
      result.push(start, best.len);
      i += best.len;
    } else {
      // Plateau
      result.push(input[i], -best.len);
      i += best.len;
    }
  }

  return result;
}

// ── Generate pairs ──────────────────────────────────────────────────────

interface Pair {
  input: number[];
  output: number[];
}

function makePair(input: number[]): Pair {
  return { input, output: encode(input) };
}

// ── TRAINING PAIRS (15) — shown to LLM ─────────────────────────────────

export const TRAINING_PAIRS: Pair[] = [
  // T1: Pure ascending run
  makePair([1, 2, 3, 4, 5]),
  // → [1, 5]

  // T2: Pure descending run
  makePair([5, 4, 3, 2, 1]),
  // → [1, 5]  (reversed: 1,2,3,4,5 → start=1, len=5)

  // T3: Pure plateau
  makePair([7, 7, 7, 7]),
  // → [7, -4]

  // T4: Two ascending runs separated by gap
  makePair([1, 2, 3, 10, 11, 12]),
  // → [1, 3, 10, 3]

  // T5: Ascending then descending
  makePair([1, 2, 3, 4, 3, 2, 1]),
  // → [1, 4, 1, 3]  (asc: 1-4 len 4, desc: 3,2,1 → start=1 len=3)

  // T6: Single values only
  makePair([5, 10, 20]),
  // → [5, 1, 10, 1, 20, 1]

  // T7: Plateau then ascending
  makePair([3, 3, 3, 4, 5, 6]),
  // → [3, -3, 4, 3]

  // T8: Mixed: ascending, single, plateau
  makePair([1, 2, 3, 7, 9, 9, 9]),
  // → [1, 3, 7, 1, 9, -3]

  // T9: Descending then plateau
  makePair([5, 4, 3, 3, 3]),
  // → [3, 3, 3, -2]  (desc: 5,4,3 → start=3 len=3; plateau: 3,3 → [3, -2])

  // T10: Long ascending
  makePair([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]),
  // → [10, 10]

  // T11: Alternating — no pattern, all singles
  makePair([1, 3, 1, 3, 1]),
  // → [1, 1, 3, 1, 1, 1, 3, 1, 1, 1]

  // T12: Negative numbers ascending
  makePair([-3, -2, -1, 0, 1]),
  // → [-3, 5]

  // T13: Negative numbers descending
  makePair([2, 1, 0, -1, -2]),
  // → [-2, 5]

  // T14: Plateau of length 2 then single
  makePair([4, 4, 7]),
  // → [4, -2, 7, 1]

  // T15: Complex mix: asc, single, desc, plateau, single
  makePair([1, 2, 3, 8, 6, 5, 4, 9, 9, 9, 9, 15]),
  // → [1, 3, 8, 1, 4, 3, 9, -4, 15, 1]
];

// ── HOLDOUT PAIRS (5) — only inputs shown to LLM, outputs used for grading ──

export const HOLDOUT_PAIRS: Pair[] = [
  // H1: Empty array
  makePair([]),
  // → []

  // H2: Single element
  makePair([42]),
  // → [42, 1]

  // H3: All same values (long plateau)
  makePair([5, 5, 5, 5, 5, 5, 5]),
  // → [5, -7]

  // H4: Strictly ascending (tests generalization to unseen length)
  makePair([100, 101, 102, 103, 104, 105, 106, 107]),
  // → [100, 8]

  // H5: Complex mixed — desc, asc, plateau, singles, negative
  makePair([10, 9, 8, 7, -1, 0, 1, 2, 3, 3, 3, 50, 48]),
  // desc: 10,9,8,7 → [7, 4]; asc: -1,0,1,2,3 → [-1, 5]; plat: 3,3 → [3, -2]; singles: 50, 48
  // → [7, 4, -1, 5, 3, -2, 50, 1, 48, 1]
];
