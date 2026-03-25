/**
 * Markdown to ANSI Terminal Renderer
 *
 * Renders markdown text to ANSI-colored terminal output.
 * Supports: headings, bold, italic, inline code, code blocks,
 * unordered lists, ordered lists, blockquotes, horizontal rules,
 * and links.
 *
 * Zero dependencies - pure ANSI escape codes.
 */

// ANSI escape codes
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const ITALIC = '\x1b[3m';
const UNDERLINE = '\x1b[4m';
const INVERSE = '\x1b[7m';
const STRIKETHROUGH = '\x1b[9m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const MAGENTA = '\x1b[35m';
const CYAN = '\x1b[36m';

const HEADER_COLORS = [
  RED,      // h1
  GREEN,    // h2
  YELLOW,   // h3
  BLUE,     // h4
  MAGENTA,  // h5
  CYAN,     // h6
];

/** Apply inline formatting: bold, italic, code, strikethrough, links */
function renderInline(text: string): string {
  let out = text;
  // Inline code (before bold/italic so backtick content is preserved)
  out = out.replace(/`([^`]+)`/g, `${INVERSE} $1 ${RESET}`);
  // Bold + italic
  out = out.replace(/\*\*\*(.+?)\*\*\*/g, `${BOLD}${ITALIC}$1${RESET}`);
  out = out.replace(/___(.+?)___/g, `${BOLD}${ITALIC}$1${RESET}`);
  // Bold
  out = out.replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${RESET}`);
  out = out.replace(/__(.+?)__/g, `${BOLD}$1${RESET}`);
  // Italic
  out = out.replace(/\*(.+?)\*/g, `${ITALIC}$1${RESET}`);
  out = out.replace(/_(.+?)_/g, `${ITALIC}$1${RESET}`);
  // Strikethrough
  out = out.replace(/~~(.+?)~~/g, `${STRIKETHROUGH}$1${RESET}`);
  // Links: [text](url)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, `${UNDERLINE}${CYAN}$1${RESET} ${DIM}($2)${RESET}`);
  return out;
}

/**
 * Render a markdown string to ANSI-colored terminal output.
 *
 * @param markdown - Raw markdown string
 * @returns ANSI-formatted string ready for terminal display
 *
 * @example
 * ```ts
 * import { renderMarkdown } from './markdown-renderer';
 * console.log(renderMarkdown('# Hello\n\nSome **bold** text'));
 * ```
 */
export function renderMarkdown(markdown: string): string {
  const lines = markdown.split('\n');
  const output: string[] = [];
  let inCodeBlock = false;
  let codeLang = '';

  for (const line of lines) {
    // Fenced code blocks
    const fenceMatch = line.match(/^(`{3,})(.*)/);
    if (fenceMatch) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLang = fenceMatch[2].trim();
        const label = codeLang ? ` ${codeLang} ` : '';
        output.push(`${DIM}---${label}---${RESET}`);
      } else {
        inCodeBlock = false;
        codeLang = '';
        output.push(`${DIM}------${RESET}`);
      }
      continue;
    }

    if (inCodeBlock) {
      output.push(`${DIM}  ${line}${RESET}`);
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())) {
      output.push(`${DIM}${'─'.repeat(40)}${RESET}`);
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2];
      const color = HEADER_COLORS[level - 1] || CYAN;
      output.push(`${color}${BOLD}${'#'.repeat(level)} ${renderInline(text)}${RESET}`);
      continue;
    }

    // Blockquote
    if (line.startsWith('>')) {
      const content = line.replace(/^>\s?/, '');
      output.push(`${GREEN}  | ${renderInline(content)}${RESET}`);
      continue;
    }

    // Unordered list
    const ulMatch = line.match(/^(\s*)[*\-+]\s+(.*)/);
    if (ulMatch) {
      const indent = ulMatch[1];
      const content = ulMatch[2];
      output.push(`${indent}${CYAN}  -${RESET} ${renderInline(content)}`);
      continue;
    }

    // Ordered list
    const olMatch = line.match(/^(\s*)(\d+)\.\s+(.*)/);
    if (olMatch) {
      const indent = olMatch[1];
      const num = olMatch[2];
      const content = olMatch[3];
      output.push(`${indent}${CYAN}  ${num}.${RESET} ${renderInline(content)}`);
      continue;
    }

    // Regular text (or empty line)
    output.push(line.trim() === '' ? '' : renderInline(line));
  }

  return output.join('\n');
}

// CLI usage: pipe markdown through this script
if (import.meta.main) {
  const input = await Bun.stdin.text();
  process.stdout.write(renderMarkdown(input));
}
