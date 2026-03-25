/**
 * text-differ: Myers diff algorithm for computing minimal text differences.
 * Supports line-level, word-level, and char-level diffs, unified diff output,
 * edit distance, and patch generation.
 */

export type DiffOp = "equal" | "insert" | "delete";

export interface DiffEdit {
  op: DiffOp;
  value: string;
}

export interface DiffOptions {
  mode?: "line" | "word" | "char";
  context?: number;
}

export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

function tokenize(text: string, mode: DiffOptions["mode"]): string[] {
  if (mode === "char") return text.split("");
  if (mode === "word") return text.split(/(\s+)/).filter((t) => t.length > 0);
  const lines = text.split("\n");
  return lines
    .map((l, i) => (i < lines.length - 1 ? l + "\n" : l))
    .filter((l, i, a) => !(i === a.length - 1 && l === ""));
}

function myersDiff(a: string[], b: string[]): DiffEdit[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];

  const v: Map<number, number> = new Map([[1, 0]]);
  const trace: Map<number, number>[] = [];

  outer: for (let d = 0; d <= max; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      const down = v.get(k - 1) ?? -1;
      const right = v.get(k + 1) ?? -1;
      let x = k === -d || (k !== d && down < right) ? right : down + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v.set(k, x);
      if (x >= n && y >= m) { trace.push(new Map(v)); break outer; }
    }
  }

  const edits: DiffEdit[] = [];
  let x = n;
  let y = m;

  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d - 1];
    const k = x - y;
    const down = prev.get(k - 1) ?? -1;
    const right = prev.get(k + 1) ?? -1;
    const prevK = k === -(d - 1) || (k !== d - 1 && down < right) ? k + 1 : k - 1;
    const prevX = prev.get(prevK) ?? 0;
    const prevY = prevX - prevK;

    while (x > prevX + 1 && y > prevY + 1) {
      edits.unshift({ op: "equal", value: a[x - 1] });
      x--; y--;
    }
    if (x === prevX + 1 && y === prevY + 1 && a[x - 1] === b[y - 1]) {
      edits.unshift({ op: "equal", value: a[x - 1] });
    } else if (prevK === k - 1) {
      edits.unshift({ op: "delete", value: a[x - 1] });
    } else {
      edits.unshift({ op: "insert", value: b[y - 1] });
    }
    x = prevX; y = prevY;
  }

  while (x > 0 && y > 0) { edits.unshift({ op: "equal", value: a[x - 1] }); x--; y--; }
  return edits;
}

/**
 * Compute minimal diff between two texts.
 * @param a - original text
 * @param b - new text
 * @param options - mode ("line" | "word" | "char"), default "line"
 */
export function diff(a: string, b: string, options: DiffOptions = {}): DiffEdit[] {
  const mode = options.mode ?? "line";
  return myersDiff(tokenize(a, mode), tokenize(b, mode));
}

/**
 * Compute edit distance (insertions + deletions) between two texts.
 */
export function editDistance(a: string, b: string, options: DiffOptions = {}): number {
  return diff(a, b, options).filter((e) => e.op !== "equal").length;
}

/**
 * Generate a unified diff patch string from DiffEdit[] (line-level diffs).
 */
export function generatePatch(
  edits: DiffEdit[],
  options: { context?: number; oldFile?: string; newFile?: string } = {}
): string {
  const ctx = options.context ?? 3;
  const oldFile = options.oldFile ?? "a/file";
  const newFile = options.newFile ?? "b/file";

  let oldLine = 1;
  let newLine = 1;
  const annotated = edits.map((e) => {
    const entry = { ...e, oldLine: e.op !== "insert" ? oldLine : -1, newLine: e.op !== "delete" ? newLine : -1 };
    if (e.op !== "insert") oldLine++;
    if (e.op !== "delete") newLine++;
    return entry;
  });

  const changed = annotated.map((e, i) => (e.op !== "equal" ? i : -1)).filter((i) => i >= 0);
  if (changed.length === 0) return "";

  const hunks: Hunk[] = [];
  let i = 0;
  while (i < changed.length) {
    const start = Math.max(0, changed[i] - ctx);
    let end = changed[i];
    while (i < changed.length && changed[i] <= end + ctx * 2) { end = changed[i]; i++; }
    end = Math.min(annotated.length - 1, end + ctx);

    const hunkLines: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    const hunkOldStart = annotated[start].oldLine > 0 ? annotated[start].oldLine : 1;
    const hunkNewStart = annotated[start].newLine > 0 ? annotated[start].newLine : 1;

    for (let j = start; j <= end; j++) {
      const e = annotated[j];
      const val = e.value.endsWith("\n") ? e.value.slice(0, -1) : e.value;
      if (e.op === "equal") { hunkLines.push(` ${val}`); oldCount++; newCount++; }
      else if (e.op === "delete") { hunkLines.push(`-${val}`); oldCount++; }
      else { hunkLines.push(`+${val}`); newCount++; }
    }
    hunks.push({ oldStart: hunkOldStart, oldCount, newStart: hunkNewStart, newCount, lines: hunkLines });
  }

  const header = `--- ${oldFile}\n+++ ${newFile}\n`;
  const body = hunks
    .map((h) => `@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@\n${h.lines.join("\n")}`)
    .join("\n");
  return header + body;
}
