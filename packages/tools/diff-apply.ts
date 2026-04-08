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

function splitLines(source: string): string[] {
  if (source === "") return [];
  const lines = source.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function joinLines(lines: string[]): string {
  return lines.length === 0 ? "" : lines.join("\n") + "\n";
}

export function validateEdits(source: string, edits: Edit[]): ValidationResult {
  const lines = splitLines(source);
  const errors: string[] = [];
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    if (edit.line < 1) {
      errors.push(`Edit[${i}]: line must be >= 1, got ${edit.line}`);
    }
    if (edit.type === "remove" && edit.line > lines.length) {
      errors.push(`Edit[${i}]: cannot remove line ${edit.line} - source has only ${lines.length} lines`);
    }
    if (edit.type === "add") {
      if (edit.line > lines.length + 1) {
        errors.push(`Edit[${i}]: cannot insert at line ${edit.line} - source has only ${lines.length} lines`);
      }
      if (edit.content === undefined) {
        errors.push(`Edit[${i}]: add edit requires content`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

export function applyEdits(source: string, edits: Edit[]): string {
  const lines = splitLines(source);
  for (const edit of edits) {
    const idx = edit.line - 1;
    if (edit.type === "add") {
      lines.splice(idx, 0, edit.content ?? "");
    } else if (edit.type === "remove" && idx >= 0 && idx < lines.length) {
      lines.splice(idx, 1);
    }
  }
  return joinLines(lines);
}

export function applyHunks(source: string, hunks: Hunk[]): string {
  const lines = splitLines(source);
  const sorted = [...hunks].sort((a, b) => b.startLine - a.startLine);
  for (const hunk of sorted) {
    const idx = hunk.startLine - 1;
    lines.splice(idx, Math.max(0, hunk.removeCount), ...hunk.insertLines);
  }
  return joinLines(lines);
}

export function revertEdits(source: string, edits: Edit[]): string {
  const lines = splitLines(source);
  const reversed = [...edits].reverse();
  for (const edit of reversed) {
    const idx = edit.line - 1;
    if (edit.type === "add" && idx >= 0 && idx < lines.length) {
      lines.splice(idx, 1);
    } else if (edit.type === "remove") {
      lines.splice(idx, 0, edit.content ?? "");
    }
  }
  return joinLines(lines);
}
