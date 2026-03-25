/**
 * tree-sitter-lite: lightweight syntax tree builder for TypeScript/JavaScript.
 * Zero native dependencies. Tokenises source code line-by-line using regex
 * patterns and extracts top-level declarations: functions, classes, imports,
 * exports, arrow functions, and class methods.
 */

export type NodeKind =
  | "import"
  | "export"
  | "function"
  | "class"
  | "arrow-function"
  | "method"
  | "root";

export interface SyntaxNode {
  kind: NodeKind;
  name?: string;
  /** 1-based line where the node starts */
  line: number;
  /** Raw source snippet (first 120 chars of the matched line) */
  source: string;
  children: SyntaxNode[];
}

export interface ParseResult {
  root: SyntaxNode;
  /** Flat list of all non-root nodes for quick iteration */
  nodes: SyntaxNode[];
}

// ---------------------------------------------------------------------------
// Regex patterns - order matters, most specific first
// ---------------------------------------------------------------------------

const PATTERNS: Array<{ kind: NodeKind; re: RegExp; nameGroup?: number }> = [
  // import with bindings
  {
    kind: "import",
    re: /^\s*import\s+(?:type\s+)?(?:\{[^}]*\}|[\w*]+(?:\s+as\s+\w+)?)\s+from\s+['"]([^'"]+)['"]/,
    nameGroup: 1,
  },
  // side-effect import
  {
    kind: "import",
    re: /^\s*import\s+['"]([^'"]+)['"]/,
    nameGroup: 1,
  },
  // export default function / async function
  {
    kind: "function",
    re: /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)/,
    nameGroup: 1,
  },
  // plain function (no export)
  {
    kind: "function",
    re: /^\s*(?:async\s+)?function\s+(\w+)/,
    nameGroup: 1,
  },
  // class declaration
  {
    kind: "class",
    re: /^\s*(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+(\w+)/,
    nameGroup: 1,
  },
  // arrow function with parens
  {
    kind: "arrow-function",
    re: /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(/,
    nameGroup: 1,
  },
  // arrow function with single param
  {
    kind: "arrow-function",
    re: /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\w+\s*=>/,
    nameGroup: 1,
  },
  // re-export or namespace export
  {
    kind: "export",
    re: /^\s*export\s+(?:\*|\{[^}]*\})\s*(?:from\s+['"]([^'"]+)['"])?/,
    nameGroup: 1,
  },
  // export default value/expression
  {
    kind: "export",
    re: /^\s*export\s+default\s+/,
  },
];

// Method pattern used inside class bodies
const METHOD_RE =
  /^\s+(?:(?:public|private|protected|static|async|readonly|override)\s+)*(\w+)\s*\(/;

// ---------------------------------------------------------------------------
// Core parser
// ---------------------------------------------------------------------------

export function parse(code: string): ParseResult {
  const lines = code.split("\n");
  const root: SyntaxNode = { kind: "root", line: 0, source: "", children: [] };
  const nodes: SyntaxNode[] = [];

  let insideClass: SyntaxNode | null = null;
  let classDepth = 0;
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1;
    const snippet = raw.slice(0, 120);

    // Track brace depth to know when we exit a class body
    for (const ch of raw) {
      if (ch === "{") braceDepth++;
      if (ch === "}") {
        braceDepth--;
        if (insideClass && braceDepth <= classDepth) {
          insideClass = null;
          classDepth = 0;
        }
      }
    }

    // Inside a class body: scan for method declarations
    if (insideClass) {
      const m = METHOD_RE.exec(raw);
      if (m && m[1] !== "constructor" && !raw.trimStart().startsWith("//")) {
        const methodNode: SyntaxNode = {
          kind: "method",
          name: m[1],
          line: lineNo,
          source: snippet,
          children: [],
        };
        insideClass.children.push(methodNode);
        nodes.push(methodNode);
      }
      continue;
    }

    // Match top-level patterns
    for (const { kind, re, nameGroup } of PATTERNS) {
      const m = re.exec(raw);
      if (!m) continue;

      const name = nameGroup !== undefined ? m[nameGroup] : undefined;
      const node: SyntaxNode = { kind, name, line: lineNo, source: snippet, children: [] };
      root.children.push(node);
      nodes.push(node);

      // Arm class-body tracking when we see an opening brace on the same line
      if (kind === "class" && raw.includes("{")) {
        insideClass = node;
        classDepth = braceDepth - 1;
      }

      break;
    }
  }

  return { root, nodes };
}

// ---------------------------------------------------------------------------
// Convenience helpers
// ---------------------------------------------------------------------------

/** Return all nodes of a given kind */
export function filterNodes(result: ParseResult, kind: NodeKind): SyntaxNode[] {
  return result.nodes.filter((n) => n.kind === kind);
}

/** Human-readable summary of node counts */
export function summarise(result: ParseResult): string {
  const counts: Partial<Record<NodeKind, number>> = {};
  for (const n of result.nodes) {
    counts[n.kind] = (counts[n.kind] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
}
