/**
 * simple-diff - ultra-simple line diff for quick comparisons
 * Self-contained, no deps. Pure TypeScript.
 */

export interface DiffResult {
  added: string[];
  removed: string[];
  unchanged: string[];
}

export interface DiffLine {
  type: "added" | "removed" | "unchanged";
  content: string;
}

/**
 * Compare two multiline strings line by line.
 * Returns added, removed, and unchanged line arrays.
 */
export function simpleDiff(a: string, b: string): DiffResult {
  const linesA = a.split("\n");
  const linesB = b.split("\n");

  const setA = new Set(linesA);
  const setB = new Set(linesB);

  const removed: string[] = [];
  const added: string[] = [];
  const unchanged: string[] = [];

  for (const line of linesA) {
    if (setB.has(line)) {
      unchanged.push(line);
    } else {
      removed.push(line);
    }
  }

  for (const line of linesB) {
    if (!setA.has(line)) {
      added.push(line);
    }
  }

  return { added, removed, unchanged };
}

/**
 * Produce an ordered diff view (like unified diff) with typed lines.
 * Preserves line order from both inputs.
 */
export function orderedDiff(a: string, b: string): DiffLine[] {
  const linesA = a.split("\n");
  const linesB = b.split("\n");

  const setB = new Set(linesB);
  const setA = new Set(linesA);

  const result: DiffLine[] = [];

  // Lines from A: removed or unchanged
  for (const line of linesA) {
    if (setB.has(line)) {
      result.push({ type: "unchanged", content: line });
    } else {
      result.push({ type: "removed", content: line });
    }
  }

  // Lines only in B: added (append at end)
  for (const line of linesB) {
    if (!setA.has(line)) {
      result.push({ type: "added", content: line });
    }
  }

  return result;
}

/**
 * Quick check - returns true if there are any differences.
 */
export function hasDifferences(a: string, b: string): boolean {
  return a !== b;
}

/**
 * Format a DiffResult as a colored terminal string.
 * Uses ANSI escape codes. Safe for any terminal.
 */
export function formatDiff(diff: DiffResult): string {
  const RESET = "\x1b[0m";
  const GREEN = "\x1b[32m";
  const RED = "\x1b[31m";
  const DIM = "\x1b[2m";

  const lines: string[] = [];

  for (const line of diff.removed) {
    lines.push(`${RED}- ${line}${RESET}`);
  }

  for (const line of diff.added) {
    lines.push(`${GREEN}+ ${line}${RESET}`);
  }

  for (const line of diff.unchanged) {
    lines.push(`${DIM}  ${line}${RESET}`);
  }

  if (lines.length === 0) {
    return `${DIM}(no differences)${RESET}`;
  }

  return lines.join("\n");
}

/**
 * Format an ordered diff (preserves sequence, more readable).
 */
export function formatOrderedDiff(lines: DiffLine[]): string {
  const RESET = "\x1b[0m";
  const GREEN = "\x1b[32m";
  const RED = "\x1b[31m";
  const DIM = "\x1b[2m";

  return lines
    .map((l) => {
      if (l.type === "added") return `${GREEN}+ ${l.content}${RESET}`;
      if (l.type === "removed") return `${RED}- ${l.content}${RESET}`;
      return `${DIM}  ${l.content}${RESET}`;
    })
    .join("\n");
}

/**
 * Summary stats for a diff.
 */
export function diffStats(diff: DiffResult): string {
  return `+${diff.added.length} -${diff.removed.length} =${diff.unchanged.length}`;
}
