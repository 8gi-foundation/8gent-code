/**
 * diff-highlighter.ts
 * Syntax-highlights unified diffs with ANSI colors for terminal display.
 * Includes word-level change detection within modified lines.
 *
 * Export: highlightDiff(diff: string): string
 */

// ANSI escape codes
const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
} as const;

function c(code: string, text: string): string {
  return `${code}${text}${ANSI.reset}`;
}

interface Token {
  text: string;
  added?: boolean;
  removed?: boolean;
}

function tokenize(line: string): string[] {
  return line.match(/\S+|\s+/g) ?? [];
}

function wordDiff(oldLine: string, newLine: string): { oldTokens: Token[]; newTokens: Token[] } {
  const oldWords = tokenize(oldLine);
  const newWords = tokenize(newLine);
  const m = oldWords.length;
  const n = newWords.length;

  // LCS DP table (bottom-up)
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (oldWords[i] === newWords[j]) {
        dp[i][j] = 1 + dp[i + 1][j + 1];
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  // Trace back to build labeled token lists
  const oldTokens: Token[] = [];
  const newTokens: Token[] = [];
  let i = 0;
  let j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && oldWords[i] === newWords[j]) {
      oldTokens.push({ text: oldWords[i] });
      newTokens.push({ text: newWords[j] });
      i++; j++;
    } else if (j < n && (i >= m || dp[i][j + 1] >= dp[i + 1][j])) {
      newTokens.push({ text: newWords[j], added: true });
      j++;
    } else {
      oldTokens.push({ text: oldWords[i], removed: true });
      i++;
    }
  }

  return { oldTokens, newTokens };
}

function renderTokens(tokens: Token[], isAddition: boolean): string {
  return tokens
    .map((t) => {
      if (isAddition && t.added) return c(ANSI.bgGreen, t.text);
      if (!isAddition && t.removed) return c(ANSI.bgRed, t.text);
      return t.text;
    })
    .join("");
}

/**
 * Highlights a unified diff string with ANSI colors for terminal display.
 *
 * Line types:
 *   --- / +++ file headers  -> bold cyan
 *   @@ hunk headers         -> cyan
 *   + additions             -> green (word-level bg-green on changed tokens)
 *   - deletions             -> red   (word-level bg-red on changed tokens)
 *   context lines           -> dim
 *   diff/index headers      -> bold
 */
export function highlightDiff(diff: string): string {
  const lines = diff.split("\n");
  const output: string[] = [];
  let pendingRemovals: string[] = [];

  function flushRemovals(additions: string[]): void {
    const count = Math.min(pendingRemovals.length, additions.length);

    // Paired lines: apply word-level diff
    for (let k = 0; k < count; k++) {
      const oldContent = pendingRemovals[k].slice(1);
      const newContent = additions[k].slice(1);
      const { oldTokens, newTokens } = wordDiff(oldContent, newContent);
      output.push(c(ANSI.red, "-") + c(ANSI.red, renderTokens(oldTokens, false)));
      output.push(c(ANSI.green, "+") + c(ANSI.green, renderTokens(newTokens, true)));
    }

    // Unpaired removals - no matching addition
    for (let k = count; k < pendingRemovals.length; k++) {
      output.push(c(ANSI.red, pendingRemovals[k]));
    }

    // Unpaired additions - no matching removal
    for (let k = count; k < additions.length; k++) {
      output.push(c(ANSI.green, additions[k]));
    }

    pendingRemovals = [];
  }

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];

    if (line.startsWith("---") || line.startsWith("+++")) {
      flushRemovals([]);
      output.push(c(ANSI.bold + ANSI.cyan, line));
    } else if (line.startsWith("@@")) {
      flushRemovals([]);
      output.push(c(ANSI.cyan, line));
    } else if (line.startsWith("diff ") || line.startsWith("index ")) {
      flushRemovals([]);
      output.push(c(ANSI.bold, line));
    } else if (line.startsWith("-")) {
      pendingRemovals.push(line);
    } else if (line.startsWith("+")) {
      // Collect all contiguous + lines, then flush with accumulated - lines
      const additions: string[] = [line];
      while (idx + 1 < lines.length && lines[idx + 1].startsWith("+")) {
        idx++;
        additions.push(lines[idx]);
      }
      flushRemovals(additions);
    } else {
      flushRemovals([]);
      output.push(line === "" ? "" : c(ANSI.dim, line));
    }
  }

  flushRemovals([]);
  return output.join("\n");
}
