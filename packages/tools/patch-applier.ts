/**
 * patch-applier.ts
 * Apply unified diff patches to source text programmatically.
 * Handles standard unified diff format (--- / +++ / @@ hunks).
 */

export interface Hunk {
  originalStart: number;
  originalCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

export interface PatchResult {
  success: boolean;
  output: string;
  conflicts: string[];
  hunksApplied: number;
  hunksSkipped: number;
}

/** Parse unified diff text into an array of hunks. */
export function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  const lines = patch.split("\n");
  let current: Hunk | null = null;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      // @@ -originalStart,originalCount +newStart,newCount @@
      const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!match) continue;
      if (current) hunks.push(current);
      current = {
        originalStart: parseInt(match[1], 10),
        originalCount: match[2] !== undefined ? parseInt(match[2], 10) : 1,
        newStart: parseInt(match[3], 10),
        newCount: match[4] !== undefined ? parseInt(match[4], 10) : 1,
        lines: [],
      };
    } else if (current && (line.startsWith("+") || line.startsWith("-") || line.startsWith(" "))) {
      current.lines.push(line);
    }
  }

  if (current) hunks.push(current);
  return hunks;
}

/** Find where a hunk's context lines actually appear in the source (fuzzy by +/-3 lines). */
function locateHunk(sourceLines: string[], hunk: Hunk, expectedLine: number): number {
  const contextLines = hunk.lines
    .filter((l) => l.startsWith(" ") || l.startsWith("-"))
    .map((l) => l.slice(1));

  if (contextLines.length === 0) return expectedLine - 1;

  const searchRadius = 3;
  const start = Math.max(0, expectedLine - 1 - searchRadius);
  const end = Math.min(sourceLines.length - contextLines.length, expectedLine - 1 + searchRadius);

  for (let offset = 0; offset <= end - start; offset++) {
    for (const dir of [0, 1, -1]) {
      const pos = expectedLine - 1 + dir * offset;
      if (pos < start || pos > end) continue;
      let match = true;
      for (let i = 0; i < contextLines.length; i++) {
        if (sourceLines[pos + i] !== contextLines[i]) {
          match = false;
          break;
        }
      }
      if (match) return pos;
    }
  }

  return -1; // not found
}

/**
 * Apply a unified diff patch string to a source string.
 * Returns a PatchResult with the modified source, conflict list, and counts.
 */
export function applyPatch(source: string, patch: string): PatchResult {
  const hunks = parseHunks(patch);
  const conflicts: string[] = [];
  let hunksApplied = 0;
  let hunksSkipped = 0;

  if (hunks.length === 0) {
    return { success: true, output: source, conflicts: [], hunksApplied: 0, hunksSkipped: 0 };
  }

  let sourceLines = source.split("\n");
  let lineOffset = 0;

  for (const hunk of hunks) {
    const actualPos = locateHunk(sourceLines, hunk, hunk.originalStart + lineOffset);

    if (actualPos === -1) {
      conflicts.push(
        `Hunk @@ -${hunk.originalStart},${hunk.originalCount} +${hunk.newStart},${hunk.newCount} @@ - context not found`
      );
      hunksSkipped++;
      continue;
    }

    // Context + removal lines that must match the source
    const contextAndRemoval = hunk.lines
      .filter((l) => l.startsWith(" ") || l.startsWith("-"))
      .map((l) => l.slice(1));

    let mismatch = false;
    for (let i = 0; i < contextAndRemoval.length; i++) {
      if (sourceLines[actualPos + i] !== contextAndRemoval[i]) {
        mismatch = true;
        break;
      }
    }

    if (mismatch) {
      conflicts.push(
        `Hunk @@ -${hunk.originalStart},${hunk.originalCount} @@ - source mismatch at line ${actualPos + 1}`
      );
      hunksSkipped++;
      continue;
    }

    // Build replacement: keep context and addition lines, drop removal lines
    const newLines: string[] = [];
    for (const line of hunk.lines) {
      if (line.startsWith("+") || line.startsWith(" ")) {
        newLines.push(line.slice(1));
      }
    }

    sourceLines = [
      ...sourceLines.slice(0, actualPos),
      ...newLines,
      ...sourceLines.slice(actualPos + contextAndRemoval.length),
    ];

    lineOffset += newLines.length - contextAndRemoval.length;
    hunksApplied++;
  }

  return {
    success: conflicts.length === 0,
    output: sourceLines.join("\n"),
    conflicts,
    hunksApplied,
    hunksSkipped,
  };
}
