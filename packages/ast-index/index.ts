/**
 * 8gent AST Index
 *
 * Symbol-level code retrieval for token-efficient agent workflows.
 * Instead of reading entire files, agents retrieve specific symbols.
 *
 * Inspired by jcodemunch, but native to 8gent.
 */

import type { Symbol, SymbolKind, FileOutline, RepoIndex } from "../types";

// Parser interface - will be implemented with tree-sitter or native TS parser
export interface Parser {
  parse(code: string, language: string): ParsedFile;
  getSupportedLanguages(): string[];
}

export interface ParsedFile {
  symbols: ParsedSymbol[];
  imports: string[];
  exports: string[];
}

export interface ParsedSymbol {
  name: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  startCol: number;
  endCol: number;
  signature?: string;
  docstring?: string;
  children?: ParsedSymbol[];
}

// ============================================
// Index Storage (in-memory, will persist to disk)
// ============================================

const repoIndices: Map<string, RepoIndex> = new Map();
const symbolMaps: Map<string, Map<string, Symbol>> = new Map();
const fileOutlines: Map<string, Map<string, FileOutline>> = new Map();

// ============================================
// Core API
// ============================================

/**
 * Index a local folder
 */
export async function indexFolder(
  path: string,
  options?: {
    incremental?: boolean;
    ignorePatterns?: string[];
  }
): Promise<RepoIndex> {
  // TODO: Implement with tree-sitter
  throw new Error("Not implemented - need parser integration");
}

/**
 * Index a GitHub repository
 */
export async function indexRepo(
  url: string,
  options?: {
    branch?: string;
    sparse?: boolean;
  }
): Promise<RepoIndex> {
  // TODO: Implement with GitHub API + parser
  throw new Error("Not implemented - need GitHub integration");
}

/**
 * Get file outline (all symbols in a file)
 */
export function getFileOutline(repoId: string, filePath: string): FileOutline | null {
  const repo = fileOutlines.get(repoId);
  if (!repo) return null;
  return repo.get(filePath) || null;
}

/**
 * Get a specific symbol by ID
 */
export function getSymbol(repoId: string, symbolId: string): Symbol | null {
  const repo = symbolMaps.get(repoId);
  if (!repo) return null;
  return repo.get(symbolId) || null;
}

/**
 * Get symbol source code
 */
export async function getSymbolSource(
  repoId: string,
  symbolId: string,
  contextLines?: number
): Promise<string | null> {
  const symbol = getSymbol(repoId, symbolId);
  if (!symbol) return null;

  // TODO: Read file and extract lines
  throw new Error("Not implemented - need file reading");
}

/**
 * Search symbols across a repo
 */
export function searchSymbols(
  repoId: string,
  query: string,
  options?: {
    kind?: SymbolKind;
    filePattern?: string;
    limit?: number;
  }
): Symbol[] {
  const repo = symbolMaps.get(repoId);
  if (!repo) return [];

  const limit = options?.limit || 20;
  const results: Symbol[] = [];
  const queryLower = query.toLowerCase();

  for (const symbol of repo.values()) {
    if (options?.kind && symbol.kind !== options.kind) continue;
    if (options?.filePattern) {
      const pattern = new RegExp(options.filePattern);
      if (!pattern.test(symbol.filePath)) continue;
    }

    // Match name, signature, or summary
    const nameMatch = symbol.name.toLowerCase().includes(queryLower);
    const sigMatch = symbol.signature?.toLowerCase().includes(queryLower);
    const sumMatch = symbol.summary?.toLowerCase().includes(queryLower);

    if (nameMatch || sigMatch || sumMatch) {
      results.push(symbol);
      if (results.length >= limit) break;
    }
  }

  return results;
}

/**
 * Get file tree for a repo
 */
export function getFileTree(
  repoId: string,
  pathPrefix?: string
): string[] {
  const outlines = fileOutlines.get(repoId);
  if (!outlines) return [];

  let paths = Array.from(outlines.keys());

  if (pathPrefix) {
    paths = paths.filter(p => p.startsWith(pathPrefix));
  }

  return paths.sort();
}

/**
 * List all indexed repos
 */
export function listRepos(): RepoIndex[] {
  return Array.from(repoIndices.values());
}

/**
 * Get repo stats
 */
export function getRepoStats(repoId: string): RepoIndex | null {
  return repoIndices.get(repoId) || null;
}

/**
 * Clear index for a repo
 */
export function clearIndex(repoId: string): boolean {
  const had = repoIndices.has(repoId);
  repoIndices.delete(repoId);
  symbolMaps.delete(repoId);
  fileOutlines.delete(repoId);
  return had;
}

// ============================================
// Token Estimation
// ============================================

/**
 * Estimate tokens for a file vs symbol retrieval
 */
export function estimateTokenSavings(
  repoId: string,
  filePath: string,
  symbolIds?: string[]
): {
  fullFileTokens: number;
  symbolOnlyTokens: number;
  savingsPercent: number;
} {
  // TODO: Implement with actual file sizes
  return {
    fullFileTokens: 0,
    symbolOnlyTokens: 0,
    savingsPercent: 0,
  };
}
