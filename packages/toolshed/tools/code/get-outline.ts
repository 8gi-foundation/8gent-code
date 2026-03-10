/**
 * 8gent Code - Get File Outline Tool
 *
 * Returns all symbols in a file without loading the full content.
 * This is the core of token-efficient code exploration.
 */

import { registerTool } from "../../registry/register";
import { parseTypeScriptFile } from "../../../ast-index/typescript-parser";
import type { ExecutionContext } from "../../../types";
import * as path from "path";
import * as fs from "fs";

interface GetOutlineInput {
  filePath: string;
  kinds?: string[];  // Filter by symbol kind
}

interface OutlineOutput {
  filePath: string;
  language: string;
  symbolCount: number;
  symbols: {
    id: string;
    name: string;
    kind: string;
    lines: string;
    signature?: string;
  }[];
  tokensSaved: number;
}

registerTool({
  name: "get_outline",
  description: "Get all symbols in a file without loading full content. Returns functions, classes, types with signatures.",
  capabilities: ["code", "code.symbol"],
  inputSchema: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Path to the file to outline",
      },
      kinds: {
        type: "array",
        items: { type: "string" },
        description: "Filter by symbol kinds (function, class, method, type, interface, constant)",
      },
    },
    required: ["filePath"],
  },
  outputSchema: {
    type: "object",
    properties: {
      filePath: { type: "string" },
      language: { type: "string" },
      symbolCount: { type: "number" },
      symbols: { type: "array" },
      tokensSaved: { type: "number" },
    },
  },
  permissions: ["read:code"],
}, async (input: unknown, context: ExecutionContext): Promise<OutlineOutput> => {
  const { filePath, kinds } = input as GetOutlineInput;

  // Resolve path
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.join(context.workingDirectory, filePath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`File not found: ${absolutePath}`);
  }

  // Get file size to calculate savings
  const fileSize = fs.statSync(absolutePath).size;
  const fullFileTokens = Math.ceil(fileSize / 4); // ~4 chars per token

  // Parse the file
  const outline = parseTypeScriptFile(absolutePath);

  // Filter by kinds if specified
  let symbols = outline.symbols;
  if (kinds && kinds.length > 0) {
    const kindSet = new Set(kinds.map(k => k.toLowerCase()));
    symbols = symbols.filter(s => kindSet.has(s.kind.toLowerCase()));
  }

  // Format output
  const formattedSymbols = symbols.map(s => ({
    id: s.id,
    name: s.name,
    kind: s.kind,
    lines: `${s.startLine}-${s.endLine}`,
    signature: s.signature,
  }));

  // Calculate tokens used by outline (rough estimate)
  const outlineTokens = Math.ceil(JSON.stringify(formattedSymbols).length / 4);
  const tokensSaved = Math.max(0, fullFileTokens - outlineTokens);

  return {
    filePath: absolutePath,
    language: outline.language,
    symbolCount: formattedSymbols.length,
    symbols: formattedSymbols,
    tokensSaved,
  };
});
