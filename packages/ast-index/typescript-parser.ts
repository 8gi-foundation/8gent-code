/**
 * 8gent Code - TypeScript AST Parser
 *
 * Uses the TypeScript Compiler API for native TS/JS parsing.
 * Zero native dependencies, perfect accuracy.
 */

import * as ts from "typescript";
import * as fs from "fs";
import * as path from "path";
import type { Symbol, SymbolKind, FileOutline } from "../types";

/**
 * Parse a TypeScript/JavaScript file and extract symbols
 */
export function parseTypeScriptFile(filePath: string): FileOutline {
  const absolutePath = path.resolve(filePath);
  const content = fs.readFileSync(absolutePath, "utf-8");
  const language = filePath.endsWith(".tsx") || filePath.endsWith(".ts")
    ? "typescript"
    : "javascript";

  const sourceFile = ts.createSourceFile(
    absolutePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") || filePath.endsWith(".jsx")
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS
  );

  const symbols: Symbol[] = [];

  function visit(node: ts.Node, parentPath: string = "") {
    const symbol = extractSymbol(node, sourceFile, parentPath);
    if (symbol) {
      symbols.push(symbol);
      // Visit children with updated path
      ts.forEachChild(node, (child) => visit(child, symbol.id));
    } else {
      ts.forEachChild(node, (child) => visit(child, parentPath));
    }
  }

  visit(sourceFile);

  return {
    filePath: absolutePath,
    language,
    symbols,
  };
}

function extractSymbol(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  parentPath: string
): Symbol | null {
  const { line: startLine } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  const { line: endLine } = sourceFile.getLineAndCharacterOfPosition(node.getEnd());

  // Function declarations
  if (ts.isFunctionDeclaration(node) && node.name) {
    return {
      id: buildSymbolId(sourceFile.fileName, node.name.text, parentPath),
      name: node.name.text,
      kind: "function",
      filePath: sourceFile.fileName,
      startLine: startLine + 1,
      endLine: endLine + 1,
      signature: getFunctionSignature(node, sourceFile),
      docstring: getJsDoc(node, sourceFile),
    };
  }

  // Arrow functions assigned to variables
  if (ts.isVariableDeclaration(node) && node.initializer) {
    if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
      const name = ts.isIdentifier(node.name) ? node.name.text : null;
      if (name) {
        return {
          id: buildSymbolId(sourceFile.fileName, name, parentPath),
          name,
          kind: "function",
          filePath: sourceFile.fileName,
          startLine: startLine + 1,
          endLine: endLine + 1,
          signature: getArrowFunctionSignature(node, sourceFile),
          docstring: getJsDoc(node.parent.parent, sourceFile),
        };
      }
    }
  }

  // Class declarations
  if (ts.isClassDeclaration(node) && node.name) {
    return {
      id: buildSymbolId(sourceFile.fileName, node.name.text, parentPath),
      name: node.name.text,
      kind: "class",
      filePath: sourceFile.fileName,
      startLine: startLine + 1,
      endLine: endLine + 1,
      signature: `class ${node.name.text}`,
      docstring: getJsDoc(node, sourceFile),
    };
  }

  // Method declarations
  if (ts.isMethodDeclaration(node) && node.name) {
    const name = ts.isIdentifier(node.name) ? node.name.text : node.name.getText(sourceFile);
    return {
      id: buildSymbolId(sourceFile.fileName, name, parentPath),
      name,
      kind: "method",
      filePath: sourceFile.fileName,
      startLine: startLine + 1,
      endLine: endLine + 1,
      signature: getMethodSignature(node, sourceFile),
      docstring: getJsDoc(node, sourceFile),
    };
  }

  // Interface declarations
  if (ts.isInterfaceDeclaration(node)) {
    return {
      id: buildSymbolId(sourceFile.fileName, node.name.text, parentPath),
      name: node.name.text,
      kind: "interface" as SymbolKind,
      filePath: sourceFile.fileName,
      startLine: startLine + 1,
      endLine: endLine + 1,
      signature: `interface ${node.name.text}`,
      docstring: getJsDoc(node, sourceFile),
    };
  }

  // Type alias declarations
  if (ts.isTypeAliasDeclaration(node)) {
    return {
      id: buildSymbolId(sourceFile.fileName, node.name.text, parentPath),
      name: node.name.text,
      kind: "type",
      filePath: sourceFile.fileName,
      startLine: startLine + 1,
      endLine: endLine + 1,
      signature: `type ${node.name.text}`,
      docstring: getJsDoc(node, sourceFile),
    };
  }

  // Const declarations (for constants)
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    const parent = node.parent;
    if (ts.isVariableDeclarationList(parent)) {
      const isConst = (parent.flags & ts.NodeFlags.Const) !== 0;
      const initializer = node.initializer;
      if (isConst && initializer && !ts.isArrowFunction(initializer) && !ts.isFunctionExpression(initializer)) {
        return {
          id: buildSymbolId(sourceFile.fileName, node.name.text, parentPath),
          name: node.name.text,
          kind: "constant",
          filePath: sourceFile.fileName,
          startLine: startLine + 1,
          endLine: endLine + 1,
          signature: `const ${node.name.text}`,
          docstring: getJsDoc(parent.parent, sourceFile),
        };
      }
    }
  }

  return null;
}

function buildSymbolId(filePath: string, name: string, parentPath: string): string {
  const relativePath = filePath; // Could normalize this
  if (parentPath) {
    return `${parentPath}::${name}`;
  }
  return `${relativePath}::${name}`;
}

function getFunctionSignature(node: ts.FunctionDeclaration, sourceFile: ts.SourceFile): string {
  const params = node.parameters.map(p => p.getText(sourceFile)).join(", ");
  const returnType = node.type ? `: ${node.type.getText(sourceFile)}` : "";
  return `function ${node.name?.text}(${params})${returnType}`;
}

function getArrowFunctionSignature(node: ts.VariableDeclaration, sourceFile: ts.SourceFile): string {
  const name = ts.isIdentifier(node.name) ? node.name.text : "anonymous";
  const init = node.initializer;
  if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
    const params = init.parameters.map(p => p.getText(sourceFile)).join(", ");
    const returnType = init.type ? `: ${init.type.getText(sourceFile)}` : "";
    return `const ${name} = (${params})${returnType} => ...`;
  }
  return `const ${name}`;
}

function getMethodSignature(node: ts.MethodDeclaration, sourceFile: ts.SourceFile): string {
  const name = node.name.getText(sourceFile);
  const params = node.parameters.map(p => p.getText(sourceFile)).join(", ");
  const returnType = node.type ? `: ${node.type.getText(sourceFile)}` : "";
  return `${name}(${params})${returnType}`;
}

function getJsDoc(node: ts.Node, sourceFile: ts.SourceFile): string | undefined {
  const jsDocTags = ts.getJSDocTags(node);
  if (jsDocTags.length > 0) {
    return jsDocTags.map(tag => tag.getText(sourceFile)).join("\n");
  }

  // Try to get leading comments
  const fullText = sourceFile.getFullText();
  const nodeStart = node.getFullStart();
  const leadingComments = ts.getLeadingCommentRanges(fullText, nodeStart);

  if (leadingComments && leadingComments.length > 0) {
    const lastComment = leadingComments[leadingComments.length - 1];
    const commentText = fullText.slice(lastComment.pos, lastComment.end);
    if (commentText.startsWith("/**")) {
      return commentText
        .replace(/^\/\*\*\s*/, "")
        .replace(/\s*\*\/$/, "")
        .replace(/^\s*\*\s?/gm, "")
        .trim();
    }
  }

  return undefined;
}

/**
 * Get source code for a specific symbol
 */
export function getSymbolSource(
  filePath: string,
  startLine: number,
  endLine: number,
  contextLines: number = 0
): string {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  const start = Math.max(0, startLine - 1 - contextLines);
  const end = Math.min(lines.length, endLine + contextLines);

  return lines.slice(start, end).join("\n");
}

/**
 * Search symbols in a file by name
 */
export function searchInFile(filePath: string, query: string): Symbol[] {
  const outline = parseTypeScriptFile(filePath);
  const queryLower = query.toLowerCase();

  return outline.symbols.filter(s =>
    s.name.toLowerCase().includes(queryLower) ||
    s.signature?.toLowerCase().includes(queryLower) ||
    s.docstring?.toLowerCase().includes(queryLower)
  );
}
