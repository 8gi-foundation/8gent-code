/**
 * CLI Help Output Colorizer
 *
 * Takes plain text help output (e.g. from --help flags) and applies
 * ANSI colors for readability: commands in cyan, flags in yellow,
 * descriptions in dim, headers in bold.
 */

// ANSI escape codes
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';

/** Detect if a line is a section header (e.g. "Usage:", "Options:", "Commands:") */
function isHeader(line: string): boolean {
  const trimmed = line.trimEnd();
  // Header: non-indented line ending with colon, or ALL CAPS line
  if (/^[A-Z][A-Za-z\s]+:$/.test(trimmed)) return true;
  if (/^[A-Z][A-Z\s]{2,}$/.test(trimmed)) return true;
  return false;
}

/** Colorize flag tokens (--foo, -f) within a line */
function colorizeFlags(line: string): string {
  return line.replace(/(?<!\w)(--?[a-zA-Z][\w-]*)(?=[\s,=\]]|$)/g, `${YELLOW}$1${RESET}`);
}

/** Colorize a single line of help output */
function colorizeLine(line: string): string {
  // Empty lines pass through
  if (line.trim() === '') return line;

  // Section headers get bold
  if (isHeader(line)) {
    return `${BOLD}${line}${RESET}`;
  }

  // Indented lines with a command/subcommand pattern:
  //   command-name   Description text here
  const cmdMatch = line.match(/^(\s{2,})([a-z][\w-]*(?:\s[a-z][\w-]*)?)(\s{2,})(.*)/);
  if (cmdMatch) {
    const [, indent, cmd, gap, desc] = cmdMatch;
    const coloredDesc = colorizeFlags(`${DIM}${desc}${RESET}`);
    return `${indent}${CYAN}${cmd}${RESET}${gap}${coloredDesc}`;
  }

  // Lines with flags get flag highlighting + dim description
  const flagLineMatch = line.match(/^(\s+)(--?[a-zA-Z][\w-]*(?:[,\s]+--?[a-zA-Z][\w-]*)*)(\s{2,})(.*)/);
  if (flagLineMatch) {
    const [, indent, flags, gap, desc] = flagLineMatch;
    const coloredFlags = colorizeFlags(flags);
    return `${indent}${coloredFlags}${gap}${DIM}${desc}${RESET}`;
  }

  // Any other line with flags - just highlight the flags
  if (/--?[a-zA-Z]/.test(line)) {
    return colorizeFlags(line);
  }

  // Default: return as-is
  return line;
}

/**
 * Colorize CLI help output text.
 *
 * @param text - Raw help output string
 * @returns ANSI-colorized string
 *
 * @example
 * ```ts
 * import { colorizeHelp } from './help-colorizer';
 * const raw = execSync('git --help').toString();
 * console.log(colorizeHelp(raw));
 * ```
 */
export function colorizeHelp(text: string): string {
  return text
    .split('\n')
    .map(colorizeLine)
    .join('\n');
}

// CLI usage: pipe help text through this script
if (import.meta.main) {
  const input = await Bun.stdin.text();
  process.stdout.write(colorizeHelp(input));
}
