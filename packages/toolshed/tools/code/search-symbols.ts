/**
 * 8gent Code - Search Symbols Tool
 *
 * Search for symbols across files by name, signature, or docstring.
 * More efficient than grep for code navigation.
 */

import { registerTool } from "../../registry/register";
import { parseTypeScriptFile } from "../../../ast-index/typescript-parser";
import type { ExecutionContext, Symbol } from "../../../types";
import * as path from "path";
import * as fs from "fs";
import { glob } from "glob";

interface SearchSymbolsInput {
  query: string;
  directory?: string;
  filePattern?: string;
  kinds?: string[];
  limit?: number;
}

interface SearchMatch {
  id: string;
  name: string;
  kind: string;
  filePath: string;
  lines: string;
  signature?: string;
  matchType: "name" | "signature" | "docstring";
}

interface SearchOutput {
  query: string;
  matchCount: number;
  matches: SearchMatch[];
  filesSearched: number;
  tokensSaved: number;
}

registerTool({
  name: "search_symbols",
  description: "Search for symbols across files by name or signature. More efficient than grep for finding code.",
  capabilities: ["code", "code.symbol"],
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query (matches symbol names, signatures, docstrings)",
      },
      directory: {
        type: "string",
        description: "Directory to search in (default: working directory)",
      },
      filePattern: {
        type: "string",
        description: "Glob pattern for files (default: **/*.{ts,tsx,js,jsx})",
      },
      kinds: {
        type: "array",
        items: { type: "string" },
        description: "Filter by symbol kinds",
      },
      limit: {
        type: "number",
        description: "Maximum results to return (default: 20)",
      },
    },
    required: ["query"],
  },
  outputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      matchCount: { type: "number" },
      matches: { type: "array" },
      filesSearched: { type: "number" },
      tokensSaved: { type: "number" },
    },
  },
  permissions: ["read:code"],
}, async (input: unknown, context: ExecutionContext): Promise<SearchOutput> => {
  const {
    query,
    directory,
    filePattern = "**/*.{ts,tsx,js,jsx}",
    kinds,
    limit = 20,
  } = input as SearchSymbolsInput;

  const searchDir = directory
    ? path.isAbsolute(directory) ? directory : path.join(context.workingDirectory, directory)
    : context.workingDirectory;

  const queryLower = query.toLowerCase();
  const kindSet = kinds ? new Set(kinds.map(k => k.toLowerCase())) : null;

  // Find files
  const files = await glob(filePattern, {
    cwd: searchDir,
    absolute: true,
    ignore: ["**/node_modules/**", "**/dist/**", "**/.git/**"],
  });

  const matches: SearchMatch[] = [];
  let totalFileSize = 0;

  for (const file of files) {
    if (matches.length >= limit) break;

    try {
      const fileSize = fs.statSync(file).size;
      totalFileSize += fileSize;

      const outline = parseTypeScriptFile(file);

      for (const symbol of outline.symbols) {
        if (matches.length >= limit) break;

        // Filter by kind if specified
        if (kindSet && !kindSet.has(symbol.kind.toLowerCase())) {
          continue;
        }

        // Check for matches
        let matchType: "name" | "signature" | "docstring" | null = null;

        if (symbol.name.toLowerCase().includes(queryLower)) {
          matchType = "name";
        } else if (symbol.signature?.toLowerCase().includes(queryLower)) {
          matchType = "signature";
        } else if (symbol.docstring?.toLowerCase().includes(queryLower)) {
          matchType = "docstring";
        }

        if (matchType) {
          matches.push({
            id: symbol.id,
            name: symbol.name,
            kind: symbol.kind,
            filePath: file,
            lines: `${symbol.startLine}-${symbol.endLine}`,
            signature: symbol.signature,
            matchType,
          });
        }
      }
    } catch {
      // Skip files that can't be parsed
    }
  }

  // Calculate savings (compared to grep which would load all files)
  const fullTokens = Math.ceil(totalFileSize / 4);
  const resultTokens = Math.ceil(JSON.stringify(matches).length / 4);
  const tokensSaved = Math.max(0, fullTokens - resultTokens);

  return {
    query,
    matchCount: matches.length,
    matches,
    filesSearched: files.length,
    tokensSaved,
  };
});
