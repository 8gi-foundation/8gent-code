/**
 * Longest Common Subsequence (LCS) algorithm.
 * Used for diff computation, merge operations, and edit script generation.
 */

/**
 * Build the LCS dynamic programming table for two arrays.
 */
function buildTable<T>(a: T[], b: T[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  return dp;
}

/**
 * Backtrack through the DP table to reconstruct the LCS.
 */
function backtrack<T>(dp: number[][], a: T[], b: T[], i: number, j: number): T[] {
  if (i === 0 || j === 0) return [];

  if (a[i - 1] === b[j - 1]) {
    return [...backtrack(dp, a, b, i - 1, j - 1), a[i - 1]];
  }

  if (dp[i - 1][j] >= dp[i][j - 1]) {
    return backtrack(dp, a, b, i - 1, j);
  }

  return backtrack(dp, a, b, i, j - 1);
}

/**
 * Returns the longest common subsequence of two arrays.
 * Elements can be any comparable type.
 *
 * @example
 * lcs(['a','b','c','d'], ['b','c','d','e']) // ['b','c','d']
 */
export function lcs<T>(a: T[], b: T[]): T[] {
  const dp = buildTable(a, b);
  return backtrack(dp, a, b, a.length, b.length);
}

/**
 * Returns only the length of the LCS without reconstructing the sequence.
 * More memory-efficient than calling lcs() when only length is needed.
 */
export function lcsLength<T>(a: T[], b: T[]): number {
  const dp = buildTable(a, b);
  return dp[a.length][b.length];
}

/**
 * Line-level LCS on two multi-line strings.
 * Splits on newlines, computes LCS of line arrays, returns matched lines.
 *
 * @example
 * lcsLines("foo\nbar\nbaz", "foo\nqux\nbaz") // ["foo", "baz"]
 */
export function lcsLines(textA: string, textB: string): string[] {
  const linesA = textA.split("\n");
  const linesB = textB.split("\n");
  return lcs(linesA, linesB);
}

export type EditOp =
  | { op: "keep"; value: string }
  | { op: "insert"; value: string }
  | { op: "delete"; value: string };

/**
 * Produces a minimal edit script (keep/insert/delete operations) to transform
 * textA into textB, operating at line granularity.
 *
 * Useful for rendering diffs and driving merge operations.
 *
 * @example
 * editScript("foo\nbar", "foo\nbaz")
 * // [
 * //   { op: "keep",   value: "foo" },
 * //   { op: "delete", value: "bar" },
 * //   { op: "insert", value: "baz" },
 * // ]
 */
export function editScript(textA: string, textB: string): EditOp[] {
  const linesA = textA.split("\n");
  const linesB = textB.split("\n");
  const dp = buildTable(linesA, linesB);

  const ops: EditOp[] = [];

  let i = linesA.length;
  let j = linesB.length;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && linesA[i - 1] === linesB[j - 1]) {
      ops.unshift({ op: "keep", value: linesA[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.unshift({ op: "insert", value: linesB[j - 1] });
      j--;
    } else {
      ops.unshift({ op: "delete", value: linesA[i - 1] });
      i--;
    }
  }

  return ops;
}
