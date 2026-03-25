/**
 * md-renderer.ts
 *
 * Render markdown to ANSI terminal output. Zero external dependencies.
 * Supports: headings, code blocks, bold, italic, links, ordered/unordered lists.
 */

// ANSI escape codes
const A = {
  reset:     '\x1b[0m',
  bold:      '\x1b[1m',
  italic:    '\x1b[3m',
  dim:       '\x1b[2m',
  underline: '\x1b[4m',
  // foreground
  cyan:      '\x1b[36m',
  yellow:    '\x1b[33m',
  green:     '\x1b[32m',
  blue:      '\x1b[34m',
  magenta:   '\x1b[35m',
  // background
  bgBlack:   '\x1b[40m',
} as const;

// --- inline renderer ----------------------------------------------------------

function renderInline(text: string): string {
  // Code spans  `code`
  text = text.replace(/`([^`]+)`/g, `${A.bgBlack}${A.green}$1${A.reset}`);

  // Bold + italic  ***text*** or ___text___
  text = text.replace(/(\*\*\*|___)(.*?)\1/g, `${A.bold}${A.italic}$2${A.reset}`);

  // Bold  **text** or __text__
  text = text.replace(/(\*\*|__)(.*?)\1/g, `${A.bold}$2${A.reset}`);

  // Italic  *text* or _text_
  text = text.replace(/(\*|_)(.*?)\1/g, `${A.italic}$2${A.reset}`);

  // Links  [label](url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, `${A.underline}${A.blue}$1${A.reset}${A.dim} ($2)${A.reset}`);

  // Autolinks  <url>
  text = text.replace(/<(https?:[^\s>]+)>/g, `${A.underline}${A.blue}$1${A.reset}`);

  return text;
}

// --- block renderer -----------------------------------------------------------

interface Block {
  type: 'heading' | 'fenced-code' | 'rule' | 'list-item' | 'blank' | 'paragraph';
  level?: number;        // heading level 1-6
  lang?: string;         // fenced code language
  lines?: string[];      // content lines
  ordered?: boolean;     // list item
  index?: number;        // ordered list number
  indent?: number;       // list indent depth
}

function parseBlocks(raw: string): Block[] {
  const inputLines = raw.split('\n');
  const blocks: Block[] = [];

  let i = 0;
  while (i < inputLines.length) {
    const line = inputLines[i];

    // Blank line
    if (line.trim() === '') {
      blocks.push({ type: 'blank' });
      i++;
      continue;
    }

    // Fenced code block  ```lang
    const fenceMatch = line.match(/^(`{3,}|~{3,})(.*)?$/);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      const lang = (fenceMatch[2] || '').trim();
      const codeLines: string[] = [];
      i++;
      while (i < inputLines.length && !inputLines[i].startsWith(fence)) {
        codeLines.push(inputLines[i]);
        i++;
      }
      i++; // closing fence
      blocks.push({ type: 'fenced-code', lang, lines: codeLines });
      continue;
    }

    // ATX headings  # heading
    const headingMatch = line.match(/^(#{1,6})\s+(.*)/);
    if (headingMatch) {
      blocks.push({ type: 'heading', level: headingMatch[1].length, lines: [headingMatch[2]] });
      i++;
      continue;
    }

    // Setext headings
    if (i + 1 < inputLines.length) {
      const next = inputLines[i + 1];
      if (/^=+\s*$/.test(next)) {
        blocks.push({ type: 'heading', level: 1, lines: [line] });
        i += 2;
        continue;
      }
      if (/^-+\s*$/.test(next)) {
        blocks.push({ type: 'heading', level: 2, lines: [line] });
        i += 2;
        continue;
      }
    }

    // Horizontal rule
    if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: 'rule' });
      i++;
      continue;
    }

    // Unordered list item
    const ulMatch = line.match(/^(\s*)([-*+])\s+(.*)/);
    if (ulMatch) {
      blocks.push({
        type: 'list-item',
        ordered: false,
        indent: Math.floor(ulMatch[1].length / 2),
        lines: [ulMatch[3]],
      });
      i++;
      continue;
    }

    // Ordered list item
    const olMatch = line.match(/^(\s*)(\d+)[.)]\s+(.*)/);
    if (olMatch) {
      blocks.push({
        type: 'list-item',
        ordered: true,
        index: parseInt(olMatch[2], 10),
        indent: Math.floor(olMatch[1].length / 2),
        lines: [olMatch[3]],
      });
      i++;
      continue;
    }

    // Paragraph - accumulate until blank or block-level element
    const paraLines: string[] = [line];
    i++;
    while (i < inputLines.length) {
      const next = inputLines[i];
      if (
        next.trim() === '' ||
        /^#{1,6}\s/.test(next) ||
        /^(`{3,}|~{3,})/.test(next) ||
        /^(\*{3,}|-{3,}|_{3,})\s*$/.test(next) ||
        /^\s*([-*+])\s/.test(next) ||
        /^\s*\d+[.)]\s/.test(next)
      ) {
        break;
      }
      paraLines.push(next);
      i++;
    }
    blocks.push({ type: 'paragraph', lines: paraLines });
  }

  return blocks;
}

// --- heading decoration -------------------------------------------------------

const HEADING_STYLES: Array<{ prefix: string; color: string; underline?: boolean }> = [
  { prefix: '',   color: `${A.bold}${A.cyan}`,    underline: true  }, // h1
  { prefix: '',   color: `${A.bold}${A.yellow}`,  underline: true  }, // h2
  { prefix: '  ', color: `${A.bold}${A.green}`,   underline: false }, // h3
  { prefix: '    ', color: `${A.bold}${A.blue}`,  underline: false }, // h4
  { prefix: '      ', color: `${A.bold}`,         underline: false }, // h5
  { prefix: '        ', color: `${A.dim}${A.bold}`, underline: false }, // h6
];

function renderHeading(level: number, text: string): string {
  const style = HEADING_STYLES[Math.min(level - 1, 5)];
  const rendered = renderInline(text);
  const line = `${style.prefix}${style.color}${rendered}${A.reset}`;
  if (!style.underline) return line;
  // underline: use the raw text length (strip ANSI for width estimate)
  const rawLen = text.replace(/\x1b\[[0-9;]*m/g, '').length + style.prefix.length;
  const char = level === 1 ? '=' : '-';
  return `${line}\n${style.color}${style.prefix}${char.repeat(rawLen)}${A.reset}`;
}

// --- code block ---------------------------------------------------------------

function renderCodeBlock(lines: string[], lang: string): string {
  const header = lang ? `${A.dim}[${lang}]${A.reset}` : '';
  const body = lines.map(l => `  ${A.green}${l}${A.reset}`).join('\n');
  return header ? `${header}\n${body}` : body;
}

// --- list item ----------------------------------------------------------------

function renderListItem(block: Block): string {
  const depth = block.indent ?? 0;
  const pad = '  '.repeat(depth);
  const bullet = block.ordered
    ? `${A.yellow}${block.index}.${A.reset} `
    : `${A.cyan}-${A.reset} `;
  const content = (block.lines ?? []).map(renderInline).join(' ');
  return `${pad}${bullet}${content}`;
}

// --- main export --------------------------------------------------------------

/**
 * Render a markdown string to ANSI-escaped terminal output.
 *
 * @param markdown - Raw markdown text
 * @returns String ready to print to a terminal that supports ANSI escape codes
 */
export function renderMarkdown(markdown: string): string {
  const blocks = parseBlocks(markdown);
  const out: string[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case 'blank':
        out.push('');
        break;

      case 'heading':
        out.push(renderHeading(block.level ?? 1, (block.lines ?? []).join(' ')));
        break;

      case 'fenced-code':
        out.push(renderCodeBlock(block.lines ?? [], block.lang ?? ''));
        break;

      case 'rule':
        out.push(`${A.dim}${'─'.repeat(60)}${A.reset}`);
        break;

      case 'list-item':
        out.push(renderListItem(block));
        break;

      case 'paragraph':
        out.push((block.lines ?? []).map(renderInline).join('\n'));
        break;
    }
  }

  return out.join('\n');
}
