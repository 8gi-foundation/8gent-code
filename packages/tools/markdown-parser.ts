/**
 * Markdown AST node types
 */
interface Node {
  type: string;
}

interface Heading extends Node {
  type: 'heading';
  level: number;
  children: InlineNode[];
}

interface Paragraph extends Node {
  type: 'paragraph';
  children: InlineNode[];
}

interface Code extends Node {
  type: 'code';
  lang: string;
  value: string;
}

interface Blockquote extends Node {
  type: 'blockquote';
  children: Node[];
}

interface List extends Node {
  type: 'list';
  children: ListItem[];
}

interface ListItem extends Node {
  type: 'listItem';
  children: Node[];
}

interface Link extends Node {
  type: 'link';
  href: string;
  title?: string;
  children: InlineNode[];
}

interface Image extends Node {
  type: 'image';
  href: string;
  title?: string;
}

interface Bold extends Node {
  type: 'bold';
  children: InlineNode[];
}

interface Italic extends Node {
  type: 'italic';
  children: InlineNode[];
}

interface InlineCode extends Node {
  type: 'inlineCode';
  value: string;
}

interface Hr extends Node {
  type: 'hr';
}

type InlineNode = Bold | Italic | InlineCode | Link | Image | Text;

interface Text extends Node {
  type: 'text';
  value: string;
}

/**
 * Parse Markdown to AST
 * @param md - Markdown string
 * @returns AST node array
 */
function parse(md: string): Node[] {
  const lines = md.split('\n');
  const ast: Node[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trimStart();
    if (!line) { i++; continue; }

    if (line.startsWith('#')) {
      const level = line.match(/^#{1,6}/)![0].length;
      const text = line.slice(level).trim();
      ast.push({
        type: 'heading',
        level,
        children: parseInline(text)
      });
      i++;
    } else if (line === '---') {
      ast.push({ type: 'hr' });
      i++;
    } else if (line.startsWith('>')) {
      const content = parseBlockquote(lines, i);
      ast.push({ type: 'blockquote', children: content });
      i += content.length + 1;
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      const list = parseList(lines, i);
      ast.push({ type: 'list', children: list });
      i += list.length + 1;
    } else {
      const para = parseParagraph(lines, i);
      ast.push({ type: 'paragraph', children: para });
      i += para.length + 1;
    }
  }

  return ast;
}

/**
 * Parse blockquote content
 */
function parseBlockquote(lines: string[], start: number): Node[] {
  const content: Node[] = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i].trimStart();
    if (!line || !line.startsWith('>')) break;
    content.push({ type: 'paragraph', children: parseInline(line.slice(1).trim()) });
    i++;
  }

  return content;
}

/**
 * Parse list content
 */
function parseList(lines: string[], start: number): ListItem[] {
  const items: ListItem[] = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i].trimStart();
    if (!line || !line.startsWith('- ') && !line.startsWith('* ')) break;
    const text = line.slice(2).trim();
    items.push({
      type: 'listItem',
      children: [{ type: 'paragraph', children: parseInline(text) }]
    });
    i++;
  }

  return items;
}

/**
 * Parse paragraph content
 */
function parseParagraph(lines: string[], start: number): InlineNode[] {
  const content: InlineNode[] = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) {
      i++;
      continue;
    }
    content.push(...parseInline(line));
    i++;
  }

  return content;
}

/**
 * Parse inline elements
 */
function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let i = 0;

  while (i < text.length) {
    if (text[i] === '**') {
      nodes.push(...parseBold(text, i));
      i += 2;
    } else if (text[i] === '*') {
      nodes.push(...parseItalic(text, i));
      i++;
    } else if (text[i] === '`') {
      nodes.push(...parseInlineCode(text, i));
      i++;
    } else if (text[i] === '[') {
      nodes.push(...parseLink(text, i));
      i++;
    } else if (text[i] === '!') {
      nodes.push(...parseImage(text, i));
      i++;
    } else {
      nodes.push({ type: 'text', value: text[i++] });
    }
  }

  return nodes;
}

/**
 * Parse bold text
 */
function parseBold(text: string, start: number): InlineNode[] {
  const nodes: InlineNode[] = [];
  let i = start + 2;

  while (i < text.length) {
    if (text.slice(i, i + 2) === '**') {
      nodes.push({ type: 'bold', children: parseInline(text.slice(start + 2, i)) });
      return nodes;
    }
    i++;
  }

  return nodes;
}

/**
 * Parse italic text
 */
function parseItalic(text: string, start: number): InlineNode[] {
  const nodes: InlineNode[] = [];
  let i = start + 1;

  while (i < text.length) {
    if (text[i] === '*') {
      nodes.push({ type: 'italic', children: parseInline(text.slice(start + 1, i)) });
      return nodes;
    }
    i++;
  }

  return nodes;
}

/**
 * Parse inline code
 */
function parseInlineCode(text: string, start: number): InlineNode[] {
  const nodes: InlineNode[] = [];
  let i = start + 1;

  while (i < text.length && text[i] !== '`') i++;
  if (i > start + 1) {
    nodes.push({ type: 'inlineCode', value: text.slice(start + 1, i) });
  }
  return nodes;
}

/**
 * Parse link
 */
function parseLink(text: string, start: number): InlineNode[] {
  const nodes: InlineNode[] = [];
  let i = start + 1;

  while (i < text.length && text[i] !== ']') i++;
  if (i <= start + 1) return nodes;
  const titleStart = text.indexOf('(', i);
  if (titleStart === -1) return nodes;

  const hrefStart = titleStart + 1;
  const hrefEnd = text.indexOf(')', hrefStart);
  if (hrefEnd === -1) return nodes;

  const title = text.slice(i + 1, hrefStart - 1);
  const href = text.slice(hrefStart, hrefEnd);
  const content = text.slice(start + 1, i);

  nodes.push({
    type: 'link',
    href,
    title,
    children: parseInline(content)
  });
  return nodes;
}

/**
 * Parse image
 */
function parseImage(text: string, start: number): InlineNode[] {
  const nodes: InlineNode[] = [];
  let i = start + 1;

  while (i < text.length && text[i] !== '!') i++;
  if (i <= start + 1) return nodes;
  const titleStart = text.indexOf('(', i);
  if (titleStart === -1) return nodes;

  const hrefStart = titleStart + 1;
  const hrefEnd = text.indexOf(')', hrefStart);
  if (hrefEnd === -1) return nodes;

  const title = text.slice(i + 1, hrefStart - 1);
  const href = text.slice(hrefStart, hrefEnd);
  const altText = text.slice(start + 2, i - 1);

  nodes.push({
    type: 'image',
    href,
    title,
    children: [{ type: 'text', value: altText }]
  });
  return nodes;
}

/**
 * Serialize AST to Markdown
 * @param nodes - AST nodes
 * @returns Markdown string
 */
function toString(nodes: Node[]): string {
  return nodes.map(n => serializeNode(n)).join('\n\n');
}

/**
 * Serialize a single node
 */
function serializeNode(node: Node): string {
  switch (node.type) {
    case 'heading':
      return '#'.repeat(node.level) + ' ' + toStringInline(node.children);
    case 'paragraph':
      return toStringInline(node.children);
    case 'code':
      return '