/**
 * ast-diff.ts
 *
 * Structural AST diff utility for TypeScript/JavaScript.
 * Compares two code strings and reports added, removed, and changed
 * top-level nodes (functions, classes, imports, exports, variables).
 *
 * Uses the TypeScript compiler API for parsing - no external deps beyond
 * the ts package already in the monorepo.
 */

import ts from "typescript";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NodeKind =
  | "function"
  | "class"
  | "import"
  | "export"
  | "variable"
  | "interface"
  | "type"
  | "enum"
  | "unknown";

export interface ASTNode {
  kind: NodeKind;
  name: string;
  /** Serialised signature - used for change detection */
  signature: string;
}

export type DiffOp = "added" | "removed" | "changed";

export interface DiffEntry {
  op: DiffOp;
  kind: NodeKind;
  name: string;
  before?: string;
  after?: string;
}

export interface ASTDiffResult {
  added: DiffEntry[];
  removed: DiffEntry[];
  changed: DiffEntry[];
  unchanged: number;
  summary: string;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function kindOf(node: ts.Node): NodeKind {
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return "function";
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isImportDeclaration(node)) return "import";
  if (ts.isExportDeclaration(node) || ts.isExportAssignment(node)) return "export";
  if (ts.isVariableStatement(node)) return "variable";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isTypeAliasDeclaration(node)) return "type";
  if (ts.isEnumDeclaration(node)) return "enum";
  return "unknown";
}

function nameOf(node: ts.Node, src: ts.SourceFile): string {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if (ts.isClassDeclaration(node) && node.name) return node.name.text;
  if (ts.isInterfaceDeclaration(node)) return node.name.text;
  if (ts.isTypeAliasDeclaration(node)) return node.name.text;
  if (ts.isEnumDeclaration(node)) return node.name.text;
  if (ts.isVariableStatement(node) && node.declarationList.declarations.length > 0) {
    const first = node.declarationList.declarations[0];
    if (ts.isIdentifier(first.name)) return first.name.text;
  }
  if (ts.isImportDeclaration(node)) {
    const spec = node.moduleSpecifier;
    return ts.isStringLiteral(spec) ? `import:${spec.text}` : "import:?";
  }
  if (ts.isExportDeclaration(node)) {
    const spec = node.moduleSpecifier;
    return spec && ts.isStringLiteral(spec) ? `export:${spec.text}` : "export:?";
  }
  // fallback - use position
  const pos = node.getStart(src);
  return `@${pos}`;
}

/** Produce a normalised signature string for change detection. */
function signatureOf(node: ts.Node, src: ts.SourceFile): string {
  // Use the raw text but strip leading/trailing whitespace and collapse
  // internal whitespace to a single space for stable comparison.
  return node.getText(src).replace(/\s+/g, " ").trim();
}

function extractNodes(code: string, fileName = "file.ts"): Map<string, ASTNode> {
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);
  const result = new Map<string, ASTNode>();

  sf.forEachChild((node) => {
    const kind = kindOf(node);
    const name = nameOf(node, sf);
    const signature = signatureOf(node, sf);
    result.set(name, { kind, name, signature });
  });

  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compare two TypeScript/JavaScript code strings and return a structural diff.
 *
 * @param codeA - "before" code
 * @param codeB - "after" code
 */
export function diffAST(codeA: string, codeB: string): ASTDiffResult {
  const nodesA = extractNodes(codeA, "a.ts");
  const nodesB = extractNodes(codeB, "b.ts");

  const added: DiffEntry[] = [];
  const removed: DiffEntry[] = [];
  const changed: DiffEntry[] = [];
  let unchanged = 0;

  // Items in B - compare to A
  for (const [name, nodeB] of nodesB) {
    const nodeA = nodesA.get(name);
    if (!nodeA) {
      added.push({ op: "added", kind: nodeB.kind, name, after: nodeB.signature });
    } else if (nodeA.signature !== nodeB.signature) {
      changed.push({ op: "changed", kind: nodeB.kind, name, before: nodeA.signature, after: nodeB.signature });
    } else {
      unchanged++;
    }
  }

  // Items in A that are no longer in B
  for (const [name, nodeA] of nodesA) {
    if (!nodesB.has(name)) {
      removed.push({ op: "removed", kind: nodeA.kind, name, before: nodeA.signature });
    }
  }

  const parts: string[] = [];
  if (added.length) parts.push(`+${added.length} added`);
  if (removed.length) parts.push(`-${removed.length} removed`);
  if (changed.length) parts.push(`~${changed.length} changed`);
  if (unchanged) parts.push(`${unchanged} unchanged`);
  const summary = parts.length ? parts.join(", ") : "no structural changes";

  return { added, removed, changed, unchanged, summary };
}
