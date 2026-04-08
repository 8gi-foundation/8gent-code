/**
 * stack-trace-parser.ts
 * Parses V8/Node.js error stack traces into structured frame objects.
 * Filters node_modules and internal frames, surfaces relevant application frames.
 */

export interface StackFrame {
  /** Raw line from the stack trace */
  raw: string;
  /** Function or method name, null for anonymous frames */
  functionName: string | null;
  /** Absolute or relative file path */
  file: string | null;
  /** 1-based line number */
  line: number | null;
  /** 1-based column number */
  column: number | null;
  /** True if this frame is inside node_modules */
  isNodeModules: boolean;
  /** True if this frame is a Node.js internal (node:, node_internals) */
  isInternal: boolean;
  /** True if this frame is likely relevant application code */
  isRelevant: boolean;
}

export interface ParsedStack {
  /** The error message (text before the first "at " frame) */
  message: string;
  /** All parsed frames in order */
  frames: StackFrame[];
  /** Only frames considered relevant (not node_modules, not internal) */
  relevantFrames: StackFrame[];
  /** Best guess at the primary failure frame (first relevant frame) */
  primaryFrame: StackFrame | null;
}

// V8: "  at FunctionName (file:line:col)"
const AT_NAMED = /^\s*at\s+(.+?)\s+\((.+):(\d+):(\d+)\)\s*$/;
// V8: "  at file:line:col" (anonymous / top-level)
const AT_ANON = /^\s*at\s+((?![^(]*\()[^(]+):(\d+):(\d+)\s*$/;

function classifyFile(file: string): { isNodeModules: boolean; isInternal: boolean } {
  const isNodeModules = file.includes("node_modules");
  const isInternal =
    file.startsWith("node:") ||
    file.includes("node_internals") ||
    file.startsWith("internal/") ||
    /^<[^>]+>$/.test(file);
  return { isNodeModules, isInternal };
}

function parseFrame(line: string): StackFrame | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("at ")) return null;

  let functionName: string | null = null;
  let file: string | null = null;
  let lineNum: number | null = null;
  let colNum: number | null = null;

  const namedMatch = trimmed.match(AT_NAMED);
  if (namedMatch) {
    functionName = namedMatch[1].trim() || null;
    file = namedMatch[2];
    lineNum = parseInt(namedMatch[3], 10);
    colNum = parseInt(namedMatch[4], 10);
  } else {
    const anonMatch = trimmed.match(AT_ANON);
    if (anonMatch) {
      file = anonMatch[1].trim();
      lineNum = parseInt(anonMatch[2], 10);
      colNum = parseInt(anonMatch[3], 10);
    } else {
      // Unrecognized at-line (e.g. "at native" with no location)
      return {
        raw: line,
        functionName: trimmed.replace(/^at\s+/, "").trim() || null,
        file: null,
        line: null,
        column: null,
        isNodeModules: false,
        isInternal: true,
        isRelevant: false,
      };
    }
  }

  // Strip file:// protocol from file URLs
  if (file) {
    file = file.replace(/^file:\/\//, "");
  }

  const { isNodeModules, isInternal } = file
    ? classifyFile(file)
    : { isNodeModules: false, isInternal: false };

  const isRelevant = !!file && !isNodeModules && !isInternal;

  return {
    raw: line,
    functionName,
    file,
    line: lineNum,
    column: colNum,
    isNodeModules,
    isInternal,
    isRelevant,
  };
}

/**
 * Parses a V8/Node.js error stack string into structured frames.
 *
 * @param stack - Full stack string (e.g. from `err.stack` or `new Error().stack`)
 * @returns ParsedStack with message, all frames, relevant frames, and primary frame
 *
 * @example
 * const result = parseStackTrace(err.stack);
 * if (result.primaryFrame) {
 *   console.log(`Failed at ${result.primaryFrame.file}:${result.primaryFrame.line}`);
 * }
 */
export function parseStackTrace(stack: string | null | undefined): ParsedStack {
  if (!stack) {
    return { message: "", frames: [], relevantFrames: [], primaryFrame: null };
  }

  const lines = stack.split("\n");
  const messageLines: string[] = [];
  const frames: StackFrame[] = [];

  for (const line of lines) {
    const frame = parseFrame(line);
    if (frame) {
      frames.push(frame);
    } else if (frames.length === 0) {
      messageLines.push(line);
    }
    // Lines appearing after frames started but failing to parse are dropped
  }

  const message = messageLines.join("\n").trim();
  const relevantFrames = frames.filter((f) => f.isRelevant);
  const primaryFrame = relevantFrames[0] ?? null;

  return { message, frames, relevantFrames, primaryFrame };
}

/**
 * Formats a StackFrame into a compact single-line string.
 * Output: "FunctionName (file:line:col)" or "file:line:col" for anonymous frames.
 */
export function formatFrame(frame: StackFrame): string {
  const loc = frame.file
    ? `${frame.file}:${frame.line ?? "?"}:${frame.column ?? "?"}`
    : "unknown";
  return frame.functionName ? `${frame.functionName} (${loc})` : loc;
}
