/**
 * md-renderer.ts — Render markdown to ANSI terminal output.
 * Zero external dependencies.
 * Supports: headings h1-h6, fenced code blocks, bold, italic,
 *           bold+italic, inline code, links, autolinks,
 *           ordered/unordered lists (nested), horizontal rules.
 */

const A = {
  reset:     '\x1b[0m',
  bold:      '\x1b[1m',
  italic:    '\x1b[3m',
  dim:       '\x1b[2m',
  underline: '\x1b[4m',
  cyan:      '\x1b[36m',
  yellow:    '\x1b[33m',
  green:     '\x1b[32m',
  blue:      '\x1b[34m',
  bgBlack:   '\x1b[40m',
} as const;

function renderInline(s: string): string {
  s = s.replace(/`([^`]+)`/g, (_, c) => `${A.bgBlack}${A.green}${c}${A.reset}`);
  s = s.replace(/(\*\*\*|___)([\s\S]*?)\1/g, (_, _d, t) => `${A.bold}${A.italic}${t}${A.reset}`);
  s = s.replace(/(\*\*|__)([\s\S]*?)\1/g, (_, _d, t) => `${A.bold}${t}${A.reset}`);
  s = s.replace(/([*_])([\s\S]*?)\1/g, (_, _d, t) => `${A.italic}${t}${A.reset}`);
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, l, u) => `${A.underline}${A.blue}${l}${A.reset}${A.dim} (${u})${A.reset}`);
  s = s.replace(/<(https?:[^\s>]+)>/g, (_, u) => `${A.underline}${A.blue}${u}${A.reset}`);
  return s;
}

type BlockType = 'heading' | 'fenced-code' | 'rule' | 'list-item' | 'blank' | 'paragraph';
interface Block {
  type: BlockType;
  level?: number; lang?: string; lines?: string[];
  ordered?: boolean; index?: number; indent?: number;
}

function parse(raw: string): Block[] {
  const ls = raw.split('\n');
  const out: Block[] = [];
  let i = 0;
  while (i < ls.length) {
    const l = ls[i];
    if (!l.trim()) { out.push({ type: 'blank' }); i++; continue; }

    // fenced code block
    const fm = l.match(/^(`{3,}|~{3,})(.*)?$/);
    if (fm) {
      const fence = fm[1], lang = (fm[2] || '').trim(), code: string[] = [];
      i++;
      while (i < ls.length && !ls[i].startsWith(fence)) code.push(ls[i++]);
      i++;
      out.push({ type: 'fenced-code', lang, lines: code }); continue;
    }

    // ATX heading
    const hm = l.match(/^(#{1,6}) +(.*)/);
    if (hm) { out.push({ type: 'heading', level: hm[1].length, lines: [hm[2]] }); i++; continue; }

    // setext heading
    if (i + 1 < ls.length) {
      if (/^=+$/.test(ls[i + 1].trim())) { out.push({ type: 'heading', level: 1, lines: [l] }); i += 2; continue; }
      if (/^-+$/.test(ls[i + 1].trim())) { out.push({ type: 'heading', level: 2, lines: [l] }); i += 2; continue; }
    }

    // thematic break
    if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(l)) { out.push({ type: 'rule' }); i++; continue; }

    // unordered list item
    const ul = l.match(/^(\s*)[*+-] +(.*)/);
    if (ul) { out.push({ type: 'list-item', ordered: false, indent: (ul[1].length >> 1), lines: [ul[2]] }); i++; continue; }

    // ordered list item
    const ol = l.match(/^(\s*)(\d+)[).] +(.*)/);
    if (ol) { out.push({ type: 'list-item', ordered: true, index: +ol[2], indent: (ol[1].length >> 1), lines: [ol[3]] }); i++; continue; }

    // paragraph
    const pl: string[] = [l]; i++;
    while (i < ls.length) {
      const n = ls[i];
      if (!n.trim() || /^#{1,6} /.test(n) || /^(`{3,}|~{3,})/.test(n) ||
          /^(\*{3,}|-{3,}|_{3,})\s*$/.test(n) || /^\s*[*+-] /.test(n) || /^\s*\d+[).] /.test(n)) break;
      pl.push(n); i++;
    }
    out.push({ type: 'paragraph', lines: pl });
  }
  return out;
}

const HEADING = [
  { p: '',         c: `\x1b[1m\x1b[36m`,     u: true,  ch: '=' },
  { p: '',         c: `\x1b[1m\x1b[33m`,     u: true,  ch: '-' },
  { p: '  ',       c: `\x1b[1m\x1b[32m`,     u: false, ch: '' },
  { p: '    ',     c: `\x1b[1m\x1b[34m`,     u: false, ch: '' },
  { p: '      ',   c: '\x1b[1m',             u: false, ch: '' },
  { p: '        ', c: '\x1b[2m\x1b[1m',      u: false, ch: '' },
];

function renderHeading(level: number, text: string): string {
  const s = HEADING[Math.min(level - 1, 5)];
  const r = `${s.p}${s.c}${renderInline(text)}\x1b[0m`;
  if (!s.u) return r;
  const w = text.replace(/\x1b\[[0-9;]*m/g, '').length + s.p.length;
  return `${r}\n${s.c}${s.p}${s.ch.repeat(w)}\x1b[0m`;
}

/**
 * Render a markdown string to ANSI-escaped terminal output.
 *
 * @param markdown Raw markdown text
 * @returns ANSI string ready to print to a terminal
 */
export function renderMarkdown(markdown: string): string {
  return parse(markdown).map(b => {
    switch (b.type) {
      case 'blank':       return '';
      case 'heading':     return renderHeading(b.level!, (b.lines ?? []).join(' '));
      case 'fenced-code': {
        const hdr = b.lang ? `\x1b[2m[${b.lang}]\x1b[0m\n` : '';
        return hdr + (b.lines ?? []).map(l => `  \x1b[32m${l}\x1b[0m`).join('\n');
      }
      case 'rule':        return `\x1b[2m${'─'.repeat(60)}\x1b[0m`;
      case 'list-item': {
        const pad = '  '.repeat(b.indent ?? 0);
        const blt = b.ordered ? `\x1b[33m${b.index}.\x1b[0m ` : `\x1b[36m-\x1b[0m `;
        return pad + blt + (b.lines ?? []).map(renderInline).join(' ');
      }
      case 'paragraph':   return (b.lines ?? []).map(renderInline).join('\n');
      default:            return '';
    }
  }).join('\n');
}
