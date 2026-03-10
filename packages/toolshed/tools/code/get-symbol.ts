/**
 * 8gent Code - Get Symbol Tool
 *
 * Retrieves the source code for a specific symbol.
 * Much more efficient than reading the entire file.
 */

import { registerTool } from "../../registry/register";
import { parseTypeScriptFile, getSymbolSource } from "../../../ast-index/typescript-parser";
import type { ExecutionContext } from "../../../types";
import * as path from "path";
import * as fs from "fs";

interface GetSymbolInput {
  symbolId: string;        // e.g., "path/to/file.ts::functionName"
  contextLines?: number;   // Lines before/after to include
}

interface SymbolOutput {
  id: string;
  name: string;
  kind: string;
  filePath: string;
  startLine: number;
  endLine: number;
  signature?: string;
  docstring?: string;
  source: string;
  tokensSaved: number;
}

registerTool({
  name: "get_symbol",
  description: "Get the source code for a specific symbol by its ID. Much more efficient than reading the full file.",
  capabilities: ["code", "code.symbol"],
  inputSchema: {
    type: "object",
    properties: {
      symbolId: {
        type: "string",
        description: "Symbol ID in format 'path/to/file.ts::symbolName'",
      },
      contextLines: {
        type: "number",
        description: "Number of lines before/after the symbol to include (default: 0)",
      },
    },
    required: ["symbolId"],
  },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      kind: { type: "string" },
      source: { type: "string" },
      tokensSaved: { type: "number" },
    },
  },
  permissions: ["read:code"],
}, async (input: unknown, context: ExecutionContext): Promise<SymbolOutput> => {
  const { symbolId, contextLines = 0 } = input as GetSymbolInput;

  // Parse symbol ID
  const separatorIndex = symbolId.lastIndexOf("::");
  if (separatorIndex === -1) {
    throw new Error(`Invalid symbol ID format. Expected 'path/to/file.ts::symbolName', got '${symbolId}'`);
  }

  const filePath = symbolId.slice(0, separatorIndex);
  const symbolName = symbolId.slice(separatorIndex + 2);

  // Resolve path
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.join(context.workingDirectory, filePath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`File not found: ${absolutePath}`);
  }

  // Get file size to calculate savings
  const fileSize = fs.statSync(absolutePath).size;
  const fullFileTokens = Math.ceil(fileSize / 4);

  // Parse and find the symbol
  const outline = parseTypeScriptFile(absolutePath);
  const symbol = outline.symbols.find(s =>
    s.name === symbolName || s.id.endsWith(`::${symbolName}`)
  );

  if (!symbol) {
    throw new Error(`Symbol '${symbolName}' not found in ${absolutePath}`);
  }

  // Get source code for just this symbol
  const source = getSymbolSource(absolutePath, symbol.startLine, symbol.endLine, contextLines);
  const symbolTokens = Math.ceil(source.length / 4);
  const tokensSaved = Math.max(0, fullFileTokens - symbolTokens);

  return {
    id: symbol.id,
    name: symbol.name,
    kind: symbol.kind,
    filePath: absolutePath,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
    signature: symbol.signature,
    docstring: symbol.docstring,
    source,
    tokensSaved,
  };
});
