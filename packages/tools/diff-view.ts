/**
 * diff-view.ts - Side-by-side unified diff renderer for the terminal.
 *
 * Zero external dependencies. Pure TypeScript.
 *
 * Exports:
 *   parseDiff(raw: string): DiffFile[]
 *   renderSideBySide(files: DiffFile[], opts?: RenderOptions): string
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  heading: string;
  lines: DiffLine[];
}

export type DiffLineType = "context" | "added" | "removed" | "noNewline";

export interface DiffLine {
  type: DiffLineType;
  content: string;
  oldLineNo?: number;
  newLineNo?: number;
}

export interface DiffFile {
  fromPath: string;
  toPath: string;
  isNew: boolean;
  isDeleted: boolean;
  isBinary: boolean;
  hunks: DiffHunk[];
}

export interface RenderOptions {
  /** Terminal column width. Default: 120. */
  width?: number;
  /** Show line numbers. Default: true. */
  lineNumbers?: boolean;
  /** Word-level intra-line highlights via LCS. Default: true. */
  wordHighlight?: boolean;
  /** Unused label for future header customisation. */
  label?: string;
}

// ---------------------------------------------------------------------------
// ANSI helpers (zero deps, no chalk)
// ---------------------------------------------------------------------------

const ANSI = {
  reset:       "\x1b[0m",
  bold:        "\x1b[1m",
  dim:         "\x1b[2m",
  fgRed:       "\x1b[31m",
  fgGreen:     "\x1b[32m",
  fgYellow:    "\x1b[33m",
  fgBlue:      "\x1b[34m",
  fgCyan:      "\x1b[36m",
  bgDarkRed:   "\x1b[48;5;52m",
  bgDarkGreen: "\x1b[48;5;22m",
} as const;

function ansiWrap(codes: string, text: string): string {
  return codes + text + ANSI.reset;
}

function visibleLength(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function padRight(s: string, width: number): string {
  const vl = visibleLength(s);
  return vl >= width ? s : s + " ".repeat(width - vl);
}

function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen - 1) + "...";
}

// ---------------------------------------------------------------------------
// parseDiff
// ---------------------------------------------------------------------------

const HUNK_HEADER  = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/;
const RE_FILE_FROM = /^--- (.+)/;
const RE_FILE_TO   = /^\+\+\+ (.+)/;
const RE_NEW_FILE  = /^new file mode/;
const RE_DEL_FILE  = /^deleted file mode/;
const RE_BINARY    = /^Binary files/;

/**
 * Parse a unified diff string into structured DiffFile objects.
 */
export function parseDiff(raw: string): DiffFile[] {
  const lines = raw.split("\n");
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let currentHunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      if (current && currentHunk) { current.hunks.push(currentHunk); currentHunk = null; }
      if (current) files.push(current);
      current = { fromPath: "", toPath: "", isNew: false, isDeleted: false, isBinary: false, hunks: [] };
      continue;
    }
    if (!current) continue;

    if (RE_NEW_FILE.test(line))  { current.isNew = true; continue; }
    if (RE_DEL_FILE.test(line))  { current.isDeleted = true; continue; }
    if (RE_BINARY.test(line))    { current.isBinary = true; continue; }

    const fromMatch = RE_FILE_FROM.exec(line);
    if (fromMatch) { current.fromPath = fromMatch[1].replace(/^a\//, ""); continue; }

    const toMatch = RE_FILE_TO.exec(line);
    if (toMatch) { current.toPath = toMatch[1].replace(/^b\//, ""); continue; }

    const hunkMatch = HUNK_HEADER.exec(line);
    if (hunkMatch) {
      if (currentHunk) current.hunks.push(currentHunk);
      oldLine = parseInt(hunkMatch[1], 10);
      newLine = parseInt(hunkMatch[3], 10);
      currentHunk = {
        oldStart: oldLine,
        oldCount: hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1,
        newStart: newLine,
        newCount: hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1,
        heading: (hunkMatch[5] || "").trim(),
        lines: [],
      };
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith("+") && !line.startsWith("+++")) {
      currentHunk.lines.push({ type: "added",   content: line.slice(1), newLineNo: newLine++ });
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      currentHunk.lines.push({ type: "removed", content: line.slice(1), oldLineNo: oldLine++ });
    } else if (line.startsWith(" ")) {
      currentHunk.lines.push({ type: "context", content: line.slice(1), oldLineNo: oldLine++, newLineNo: newLine++ });
    } else if (line.startsWith("\\")) {
      currentHunk.lines.push({ type: "noNewline", content: line.slice(2) });
    }
  }

  if (current) { if (currentHunk) current.hunks.push(currentHunk); files.push(current); }
  return files;
}

// ---------------------------------------------------------------------------
// Word-level diff (LCS-based, intra-line)
// ---------------------------------------------------------------------------

type EditOp = { type: "eq" | "del" | "ins"; text: string };

function tokenize(s: string): string[] {
  return s.split(/(\s+|[^a-zA-Z0-9_]+)/).filter(t => t.length > 0);
}

function lcsEdits(a: string[], b: string[]): EditOp[] {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);

  const ops: EditOp[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.push({ type: "eq",  text: a[i - 1] }); i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: "ins", text: b[j - 1] }); j--;
    } else {
      ops.push({ type: "del", text: a[i - 1] }); i--;
    }
  }
  return ops.reverse();
}

function wordHighlightPair(oldC: string, newC: string): [string, string] {
  const ops = lcsEdits(tokenize(oldC), tokenize(newC));
  let lo = "", ln = "";
  for (const op of ops) {
    if (op.type === "eq")  { lo += op.text; ln += op.text; }
    if (op.type === "del") { lo += ansiWrap(ANSI.bgDarkRed   + ANSI.fgRed   + ANSI.bold, op.text); }
    if (op.type === "ins") { ln += ansiWrap(ANSI.bgDarkGreen + ANSI.fgGreen + ANSI.bold, op.text); }
  }
  return [lo, ln];
}

// ---------------------------------------------------------------------------
// renderSideBySide
// ---------------------------------------------------------------------------

/**
 * Render parsed diff files as a side-by-side ANSI-colored terminal string.
 */
export function renderSideBySide(files: DiffFile[], opts: RenderOptions = {}): string {
  const totalWidth  = opts.width ?? 120;
  const showLineNos = opts.lineNumbers !== false;
  const doWordHL    = opts.wordHighlight !== false;
  const gutterW     = showLineNos ? 5 : 0;
  const sideW       = Math.floor((totalWidth - 3) / 2) - gutterW;
  const out: string[] = [];

  const hr = (ch = "-") => ansiWrap(ANSI.dim, ch.repeat(totalWidth));

  const gutter = (n?: number) =>
    showLineNos
      ? ansiWrap(ANSI.dim, (n !== undefined ? String(n).padStart(4) : "    ") + " ")
      : "";

  const colorLine = (type: DiffLineType, text: string): string => {
    if (type === "added")     return ansiWrap(ANSI.fgGreen,  text);
    if (type === "removed")   return ansiWrap(ANSI.fgRed,    text);
    if (type === "noNewline") return ansiWrap(ANSI.dim + ANSI.fgYellow, text);
    return text;
  };

  const row = (
    lg: string, lt: string, ltype: DiffLineType,
    rg: string, rt: string, rtype: DiffLineType,
  ) =>
    padRight(lg + colorLine(ltype, truncate(lt, sideW)), gutterW + sideW) +
    ansiWrap(ANSI.dim, " | ") +
    rg + colorLine(rtype, truncate(rt, sideW));

  for (const file of files) {
    const label = file.fromPath === file.toPath
      ? file.toPath
      : `${file.fromPath} -> ${file.toPath}`;
    const badge = file.isNew
      ? " [new]"
      : file.isDeleted ? " [deleted]" : file.isBinary ? " [binary]" : "";

    out.push(hr("="));
    out.push(ansiWrap(ANSI.bold + ANSI.fgCyan, `  ${label}${badge}`));
    out.push(hr("="));

    if (file.isBinary) {
      out.push(ansiWrap(ANSI.dim, "  (binary file - no diff available)"));
      continue;
    }

    for (const hunk of file.hunks) {
      const range = `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`;
      out.push(ansiWrap(ANSI.fgBlue, `  ${range}${hunk.heading ? "  " + hunk.heading : ""}`));
      out.push(hr());

      const dl = hunk.lines;
      let i = 0;
      while (i < dl.length) {
        const line = dl[i];
        if (line.type === "context" || line.type === "noNewline") {
          out.push(row(
            gutter(line.oldLineNo), line.content, line.type,
            gutter(line.newLineNo), line.content, line.type,
          ));
          i++;
          continue;
        }

        // Collect adjacent removed/added lines and pair them for word diff
        const removed: DiffLine[] = [];
        const added:   DiffLine[] = [];
        while (i < dl.length && dl[i].type === "removed") removed.push(dl[i++]);
        while (i < dl.length && dl[i].type === "added")   added.push(dl[i++]);

        const count = Math.max(removed.length, added.length);
        for (let p = 0; p < count; p++) {
          const rem = removed[p];
          const add = added[p];
          let lc = rem?.content ?? "";
          let rc = add?.content ?? "";
          if (doWordHL && rem && add) [lc, rc] = wordHighlightPair(rem.content, add.content);
          out.push(row(
            gutter(rem?.oldLineNo), lc, rem ? "removed" : "context",
            gutter(add?.newLineNo), rc, add ? "added"   : "context",
          ));
        }
      }

      out.push(hr());
    }
  }

  return out.join("\n");
}
