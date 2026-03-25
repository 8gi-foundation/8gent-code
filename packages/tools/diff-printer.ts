/**
 * diff-printer
 * Compute a unified diff between two strings and return an ANSI-colored result.
 * Zero dependencies. Under 100 lines.
 */

const ANSI_GREEN = "\x1b[32m";
const ANSI_RED   = "\x1b[31m";
const ANSI_CYAN  = "\x1b[36m";
const ANSI_RESET = "\x1b[0m";

interface Hunk {
  aStart: number;
  aLen:   number;
  bStart: number;
  bLen:   number;
  lines:  string[];
}

function lcs(a: string[], b: string[]): boolean[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);

  // backtrack to build match table
  const match: boolean[][] = Array.from({ length: m }, () => new Array(n).fill(false));
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { match[i - 1][j - 1] = true; i--; j--; }
    else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
    else j--;
  }
  return match;
}

function buildHunks(a: string[], b: string[], context: number): Hunk[] {
  const match = lcs(a, b);
  // tag each line of a/b as equal | removed | added
  type Tag = { tag: "equal" | "remove" | "add"; line: string; ai: number; bi: number };
  const ops: Tag[] = [];
  let ai = 0, bi = 0;
  while (ai < a.length || bi < b.length) {
    if (ai < a.length && bi < b.length && match[ai][bi]) {
      ops.push({ tag: "equal", line: a[ai], ai, bi }); ai++; bi++;
    } else if (ai < a.length && (bi >= b.length || !match[ai].slice(bi).includes(true))) {
      ops.push({ tag: "remove", line: a[ai], ai, bi }); ai++;
    } else {
      ops.push({ tag: "add", line: b[bi], ai, bi }); bi++;
    }
  }

  const hunks: Hunk[] = [];
  let idx = 0;
  while (idx < ops.length) {
    if (ops[idx].tag === "equal") { idx++; continue; }
    // find the span of changed lines
    let start = Math.max(0, idx - context);
    let end   = idx;
    while (end < ops.length && (ops[end].tag !== "equal" || end - idx < context)) end++;
    end = Math.min(ops.length - 1, end + context);

    const slice = ops.slice(start, end + 1);
    const aLines = slice.filter(o => o.tag !== "add");
    const bLines = slice.filter(o => o.tag !== "remove");
    const hunk: Hunk = {
      aStart: (aLines[0]?.ai ?? 0) + 1,
      aLen:   aLines.length,
      bStart: (bLines[0]?.bi ?? 0) + 1,
      bLen:   bLines.length,
      lines:  slice.map(o => {
        if (o.tag === "add")    return `${ANSI_GREEN}+${o.line}${ANSI_RESET}`;
        if (o.tag === "remove") return `${ANSI_RED}-${o.line}${ANSI_RESET}`;
        return ` ${o.line}`;
      }),
    };
    hunks.push(hunk);
    idx = end + 1;
  }
  return hunks;
}

export interface DiffOptions {
  /** Number of context lines around each change. Default: 3. */
  context?: number;
  /** Label for the "before" file shown in the header. Default: "a". */
  labelA?: string;
  /** Label for the "after" file shown in the header. Default: "b". */
  labelB?: string;
}

/**
 * Compute a unified diff between strings `a` and `b`.
 * Returns an ANSI-colored string ready for terminal output.
 * Returns an empty string when `a === b`.
 */
export function printDiff(a: string, b: string, options: DiffOptions = {}): string {
  if (a === b) return "";
  const context = options.context ?? 3;
  const labelA  = options.labelA ?? "a";
  const labelB  = options.labelB ?? "b";
  const aLines  = a.split("\n");
  const bLines  = b.split("\n");
  const hunks   = buildHunks(aLines, bLines, context);
  if (hunks.length === 0) return "";

  const header = `${ANSI_CYAN}--- ${labelA}\n+++ ${labelB}${ANSI_RESET}`;
  const body   = hunks.map(h => {
    const range = `${ANSI_CYAN}@@ -${h.aStart},${h.aLen} +${h.bStart},${h.bLen} @@${ANSI_RESET}`;
    return [range, ...h.lines].join("\n");
  }).join("\n");

  return [header, body].join("\n");
}
