/**
 * file-diff - reads two files and returns structured diff data
 * Zero dependencies except node:fs. Pure TypeScript.
 */

import { readFile } from "node:fs/promises";

export interface DiffHunk {
  startLine: number;
  lines: string[]; // prefixed with "+" or "-"
}

export interface FileDiffResult {
  added: number;
  removed: number;
  unchanged: number;
  hunks: DiffHunk[];
  error?: string;
}

/**
 * LCS-based diff to compute edit operations between two line arrays.
 * Returns a sequence of { type, content } entries in order.
 */
function computeDiff(
  linesA: string[],
  linesB: string[]
): Array<{ type: "added" | "removed" | "unchanged"; content: string }> {
  const m = linesA.length;
  const n = linesB.length;

  // Build LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0)
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        linesA[i - 1] === linesB[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack to build diff
  const result: Array<{ type: "added" | "removed" | "unchanged"; content: string }> = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && linesA[i - 1] === linesB[j - 1]) {
      result.push({ type: "unchanged", content: linesA[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({ type: "added", content: linesB[j - 1] });
      j--;
    } else {
      result.push({ type: "removed", content: linesA[i - 1] });
      i--;
    }
  }
  result.reverse();
  return result;
}

/**
 * Group consecutive non-unchanged lines into hunks.
 */
function buildHunks(
  ops: Array<{ type: "added" | "removed" | "unchanged"; content: string }>
): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let lineNum = 1;
  let i = 0;

  while (i < ops.length) {
    if (ops[i].type === "unchanged") {
      lineNum++;
      i++;
    } else {
      const hunk: DiffHunk = { startLine: lineNum, lines: [] };
      while (i < ops.length && ops[i].type !== "unchanged") {
        const prefix = ops[i].type === "added" ? "+" : "-";
        hunk.lines.push(`${prefix}${ops[i].content}`);
        if (ops[i].type !== "added") lineNum++;
        i++;
      }
      hunks.push(hunk);
    }
  }

  return hunks;
}

/**
 * Compare two files and return structured diff data.
 * Handles missing files gracefully via the error field.
 */
export async function fileDiff(
  pathA: string,
  pathB: string
): Promise<FileDiffResult> {
  let textA: string;
  let textB: string;

  try {
    [textA, textB] = await Promise.all([
      readFile(pathA, "utf8"),
      readFile(pathB, "utf8"),
    ]);
  } catch (err) {
    return {
      added: 0,
      removed: 0,
      unchanged: 0,
      hunks: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const linesA = textA.split("\n");
  const linesB = textB.split("\n");
  const ops = computeDiff(linesA, linesB);

  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const op of ops) {
    if (op.type === "added") added++;
    else if (op.type === "removed") removed++;
    else unchanged++;
  }

  return { added, removed, unchanged, hunks: buildHunks(ops) };
}
