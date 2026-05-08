/**
 * Import Sorter - sorts TypeScript imports into grouped sections.
 *
 * Groups (separated by blank lines):
 *   1. External dependencies (from 'react', from 'zod', etc.)
 *   2. Internal packages   (from '@8gent/...', from '@/...')
 *   3. Relative imports     (from './', from '../')
 *
 * Usage:
 *   sortImports(sourceText) => sorted source text
 */

export interface ImportLine {
  raw: string;
  source: string;
  group: 'external' | 'internal' | 'relative';
}

const IMPORT_RE = /^import\s[\s\S]*?from\s+['"]([^'"]+)['"];?\s*$/;
const SIDE_EFFECT_RE = /^import\s+['"]([^'"]+)['"];?\s*$/;

function extractSource(line: string): string | null {
  const m = line.match(IMPORT_RE) ?? line.match(SIDE_EFFECT_RE);
  return m ? m[1] : null;
}

function classify(source: string): ImportLine['group'] {
  if (source.startsWith('.')) return 'relative';
  if (source.startsWith('@8gent/') || source.startsWith('@/')) return 'internal';
  return 'external';
}

/**
 * Parse a single import statement (may span multiple lines when collapsed
 * by the caller) and classify it.
 */
function parseLine(raw: string): ImportLine | null {
  const source = extractSource(raw);
  if (!source) return null;
  return { raw, source, group: classify(source) };
}

/**
 * Collect contiguous import lines from the top of a file, handling
 * multi-line imports that use curly braces across lines.
 */
function extractImportBlock(lines: string[]): { imports: string[]; rest: string[] } {
  const imports: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('import ')) {
      // Could be multi-line
      let acc = line;
      while (!acc.includes("from ") && !SIDE_EFFECT_RE.test(acc) && i + 1 < lines.length) {
        i++;
        acc += '\n' + lines[i];
      }
      imports.push(acc);
    } else if (line.trim() === '' && imports.length > 0) {
      // blank line between existing import groups - skip it
    } else if (imports.length > 0) {
      break; // end of import block
    } else if (line.trim() === '' || line.startsWith('//') || line.startsWith('/*') || line.startsWith(' *') || line.startsWith('*/')) {
      // preamble (comments, blank lines before imports) - keep as-is
      i++;
      continue;
    } else {
      break;
    }
    i++;
  }
  return { imports, rest: lines.slice(i) };
}

/**
 * Sort TypeScript imports in the given source text.
 * Returns the full file text with imports sorted and grouped.
 */
export function sortImports(source: string): string {
  const lines = source.split('\n');
  const preamble: string[] = [];

  // Collect any leading comments / blank lines before the first import
  let start = 0;
  while (start < lines.length && !lines[start].startsWith('import ')) {
    preamble.push(lines[start]);
    start++;
  }

  const { imports, rest } = extractImportBlock(lines.slice(start));
  if (imports.length === 0) return source;

  const parsed = imports.map(parseLine).filter(Boolean) as ImportLine[];

  const groups: Record<ImportLine['group'], ImportLine[]> = {
    external: [],
    internal: [],
    relative: [],
  };
  for (const p of parsed) groups[p.group].push(p);

  // Sort alphabetically within each group by source path
  for (const g of Object.values(groups)) g.sort((a, b) => a.source.localeCompare(b.source));

  const sections = (['external', 'internal', 'relative'] as const)
    .map(k => groups[k].map(i => i.raw))
    .filter(s => s.length > 0);

  const sorted = sections.map(s => s.join('\n')).join('\n\n');

  return [...preamble, sorted, '', ...rest].join('\n');
}
