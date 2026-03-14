/**
 * 8gent AST Index
 *
 * Symbol-level code retrieval for token-efficient agent workflows.
 * Instead of reading entire files, agents retrieve specific symbols.
 *
 * Inspired by jcodemunch, but native to 8gent.
 */

import type { Symbol, SymbolKind, FileOutline, RepoIndex } from "../types";
import { parseTypeScriptFile } from "./typescript-parser";
import * as fs from "fs";
import * as path from "path";

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
  folderPath: string,
  options?: {
    incremental?: boolean;
    ignorePatterns?: string[];
  }
): Promise<RepoIndex> {
  const absolutePath = path.resolve(folderPath);
  const repoId = path.basename(absolutePath);
  const ignorePatterns = options?.ignorePatterns ?? ["node_modules", "dist", ".git", ".next", "coverage"];

  const files: string[] = [];
  function walkDirectory(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (ignorePatterns.some(p => entry.name === p || entry.name.startsWith("."))) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDirectory(fullPath);
      } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
        files.push(fullPath);
      }
    }
  }
  walkDirectory(absolutePath);

  const repoSymbolMap = new Map<string, Symbol>();
  const repoFileOutlines = new Map<string, FileOutline>();
  const languages: Record<string, number> = {};

  for (const file of files) {
    try {
      const outline = parseTypeScriptFile(file);
      const relativePath = path.relative(absolutePath, file);
      repoFileOutlines.set(relativePath, outline);

      const lang = outline.language;
      languages[lang] = (languages[lang] || 0) + 1;

      for (const symbol of outline.symbols) {
        repoSymbolMap.set(symbol.id, symbol);
      }
    } catch {
      // Skip files that fail to parse
    }
  }

  const repoIndex: RepoIndex = {
    id: repoId,
    sourceRoot: absolutePath,
    indexedAt: new Date().toISOString(),
    fileCount: repoFileOutlines.size,
    symbolCount: repoSymbolMap.size,
    languages,
  };

  repoIndices.set(repoId, repoIndex);
  symbolMaps.set(repoId, repoSymbolMap);
  fileOutlines.set(repoId, repoFileOutlines);

  return repoIndex;
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
  throw new Error("Use indexFolder() with a local checkout. Remote indexing not yet supported.");
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
  contextLines: number = 0
): Promise<string | null> {
  const symbol = getSymbol(repoId, symbolId);
  if (!symbol) return null;

  try {
    const content = fs.readFileSync(symbol.filePath, "utf-8");
    const lines = content.split("\n");
    const start = Math.max(0, symbol.startLine - 1 - contextLines);
    const end = Math.min(lines.length, symbol.endLine + contextLines);
    return lines.slice(start, end).join("\n");
  } catch {
    return null;
  }
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
  const outline = fileOutlines.get(repoId)?.get(filePath);
  if (!outline) {
    return { fullFileTokens: 0, symbolOnlyTokens: 0, savingsPercent: 0 };
  }

  let fullFileTokens = 0;
  try {
    const stats = fs.statSync(outline.filePath);
    fullFileTokens = Math.ceil(stats.size / 4);
  } catch {
    return { fullFileTokens: 0, symbolOnlyTokens: 0, savingsPercent: 0 };
  }

  const symbols = symbolIds
    ? outline.symbols.filter(s => symbolIds.includes(s.id))
    : outline.symbols;

  const symbolLines = symbols.reduce((sum, s) => sum + (s.endLine - s.startLine + 1), 0);
  const symbolOnlyTokens = Math.ceil((symbolLines * 40) / 4); // ~40 chars per line estimate

  const savingsPercent = fullFileTokens > 0
    ? Math.round(((fullFileTokens - symbolOnlyTokens) / fullFileTokens) * 100)
    : 0;

  return { fullFileTokens, symbolOnlyTokens, savingsPercent };
}
