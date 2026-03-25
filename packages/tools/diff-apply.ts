/**
 * diff-apply.ts
 * Applies text diffs (add/remove line edits) to source strings.
 * Self-contained - no external dependencies.
 */

export type EditType = "add" | "remove";

export interface Edit {
  type: EditType;
  /** 1-based line number. For "add", inserts before this line. */
  line: number;
  content?: string;
}

export interface Hunk {
  /** 1-based start line in the original source */
  startLine: number;
  /** Lines to remove (count) */
  removeCount: number;
  /** Lines to insert in place of removed lines */
  insertLines: string[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Splits source into lines, preserving trailing newline info.
 */
function splitLines(source: string): string[] {
  if (source === "") return [];
  const lines = source.split("\n");
  // If source ends with newline, split produces trailing empty string - remove it
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function joinLines(lines: string[]): string {
  return lines.length === 0 ? "" : lines.join("\n") + "\n";
}

/**
 * Validates edits against the source before applying.
 * Returns a list of errors - empty means valid.
 */
export function validateEdits(source: string, edits: Edit[]): ValidationResult {
  const lines = splitLines(source);
  const errors: string[] = [];

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    if (edit.line < 1) {
      errors.push(`Edit[${i}]: line must be >= 1, got ${edit.line}`);
    }
    if (edit.type === "remove") {
      if (edit.line > lines.length) {
        errors.push(
          `Edit[${i}]: cannot remove line ${edit.line} - source has only ${lines.length} lines`
        );
      }
    }
    if (edit.type === "add") {
      if (edit.line > lines.length + 1) {
        errors.push(
          `Edit[${i}]: cannot insert at line ${edit.line} - source has only ${lines.length} lines`
        );
      }
      if (edit.content === undefined) {
        errors.push(`Edit[${i}]: add edit requires content`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Applies a list of line edits to a source string.
 * Edits are applied in order, with line numbers referring to the current
 * (already-mutated) state after prior edits.
 */
export function applyEdits(source: string, edits: Edit[]): string {
  let lines = splitLines(source);

  for (const edit of edits) {
    const idx = edit.line - 1; // convert to 0-based
    if (edit.type === "add") {
      const content = edit.content ?? "";
      lines.splice(idx, 0, content);
    } else if (edit.type === "remove") {
      if (idx >= 0 && idx < lines.length) {
        lines.splice(idx, 1);
      }
    }
  }

  return joinLines(lines);
}

/**
 * Applies unified hunk-style edits to source.
 * Each hunk removes `removeCount` lines starting at `startLine`
 * and inserts `insertLines` in their place.
 * Hunks must be sorted by startLine (ascending) and non-overlapping.
 */
export function applyHunks(source: string, hunks: Hunk[]): string {
  let lines = splitLines(source);
  // Apply in reverse order so line numbers stay valid
  const sorted = [...hunks].sort((a, b) => b.startLine - a.startLine);

  for (const hunk of sorted) {
    const idx = hunk.startLine - 1;
    const removeCount = Math.max(0, hunk.removeCount);
    lines.splice(idx, removeCount, ...hunk.insertLines);
  }

  return joinLines(lines);
}

/**
 * Reverts a set of previously applied edits.
 * Replays the inverse operations in reverse order.
 * - add reverts to remove
 * - remove reverts to add (restoring original content)
 */
export function revertEdits(source: string, edits: Edit[]): string {
  let lines = splitLines(source);
  // Process in reverse to undo in correct order
  const reversed = [...edits].reverse();

  for (const edit of reversed) {
    const idx = edit.line - 1;
    if (edit.type === "add") {
      // Undo an add: remove the line that was added
      if (idx >= 0 && idx < lines.length) {
        lines.splice(idx, 1);
      }
    } else if (edit.type === "remove") {
      // Undo a remove: re-insert the original content
      const content = edit.content ?? "";
      lines.splice(idx, 0, content);
    }
  }

  return joinLines(lines);
}
