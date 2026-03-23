/**
 * EntityExtractor — Heuristic-based entity and relationship extraction
 * from agent tool results.
 *
 * This is v1: pure pattern matching, no LLM calls. Keeps extraction
 * fast (<1ms) and free. The architecture doc specifies LLM-judged extraction
 * as a future upgrade path.
 *
 * Extracts:
 *   - File operations  -> file entities
 *   - Package.json reads -> package entities + depends_on relationships
 *   - Git operations   -> decision entities
 *   - User corrections -> preference entities
 */

import type { EntityType, RelationshipType } from "./graph.js";

// ============================================
// Types
// ============================================

export interface ExtractedEntity {
  type: EntityType;
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface ExtractedRelationship {
  fromName: string;
  fromType: EntityType;
  toName: string;
  toType: EntityType;
  type: RelationshipType;
  metadata?: Record<string, unknown>;
}

export interface ExtractionResult {
  entities: ExtractedEntity[];
  relationships: ExtractedRelationship[];
}

// ============================================
// Path helpers
// ============================================

function basename(filePath: string): string {
  const parts = filePath.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || filePath;
}

function extname(filePath: string): string {
  const base = basename(filePath);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot) : "";
}

/**
 * Extract a package name from a path containing node_modules or a scope.
 * Returns null if the path is not a package path.
 */
function inferPackageFromPath(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, "/");
  const match = normalized.match(/node_modules\/(@[^/]+\/[^/]+|[^/]+)/);
  return match ? match[1] : null;
}

// ============================================
// Extraction heuristics
// ============================================

/**
 * Extract entities and relationships from a tool call result.
 * Pure heuristic — no LLM involved, designed to be <1ms.
 */
export function extractFromToolResult(
  toolName: string,
  args: Record<string, unknown>,
  result: string
): ExtractionResult {
  const entities: ExtractedEntity[] = [];
  const relationships: ExtractedRelationship[] = [];

  // ── File operations ──────────────────────────────────────────────

  if (
    toolName === "read_file" ||
    toolName === "write_file" ||
    toolName === "edit_file"
  ) {
    const filePath = String(args.path || args.file_path || "");
    if (filePath) {
      entities.push({
        type: "file",
        name: filePath,
        description: `${toolName === "read_file" ? "Read" : toolName === "write_file" ? "Written" : "Edited"} file`,
        metadata: {
          extension: extname(filePath),
          operation: toolName,
          lastTouched: Date.now(),
        },
      });

      // If reading package.json, extract package entities
      if (basename(filePath) === "package.json" && toolName === "read_file") {
        extractFromPackageJson(filePath, result, entities, relationships);
      }

      // If reading/writing a config file, tag it
      const configPatterns = [
        "tsconfig",
        ".eslintrc",
        ".prettierrc",
        "vite.config",
        "next.config",
        "tailwind.config",
        "webpack.config",
        ".env",
      ];
      const base = basename(filePath).toLowerCase();
      for (const pat of configPatterns) {
        if (base.includes(pat.toLowerCase())) {
          entities.push({
            type: "file",
            name: filePath,
            description: `Configuration file: ${base}`,
            metadata: { configType: pat },
          });
          break;
        }
      }

      // Extract function/class names from TypeScript/JavaScript writes
      if (
        (toolName === "write_file" || toolName === "edit_file") &&
        /\.(ts|tsx|js|jsx)$/.test(filePath)
      ) {
        extractFunctionsFromCode(filePath, result, entities, relationships);
      }
    }
  }

  // ── Search/grep results → file entities ────────────────────────────

  if (toolName === "search_files" || toolName === "grep") {
    const pattern = String(args.pattern || args.query || "");
    if (pattern) {
      entities.push({
        type: "concept",
        name: pattern,
        description: `Search pattern used`,
        metadata: { toolName },
      });
    }
  }

  // ── Run command / shell ────────────────────────────────────────────

  if (toolName === "run_command" || toolName === "bash") {
    const command = String(args.command || "");
    extractFromCommand(command, result, entities, relationships);
  }

  // ── Git operations → decision entities ─────────────────────────────

  if (toolName === "git_commit" || toolName === "git") {
    const message = String(args.message || args.commit_message || "");
    if (message) {
      entities.push({
        type: "decision",
        name: message.slice(0, 120),
        description: `Git commit: ${message}`,
        metadata: { toolName, fullMessage: message },
      });
    }
  }

  // ── List/directory operations ──────────────────────────────────────

  if (toolName === "list_files" || toolName === "list_directory") {
    const dirPath = String(args.path || args.directory || "");
    if (dirPath) {
      entities.push({
        type: "file",
        name: dirPath,
        description: "Directory listing",
        metadata: { isDirectory: true },
      });
    }
  }

  // ── Tool usage tracking ────────────────────────────────────────────

  if (toolName) {
    entities.push({
      type: "tool",
      name: toolName,
      description: `Agent tool: ${toolName}`,
      metadata: { lastUsed: Date.now() },
    });
  }

  return { entities, relationships };
}

// ============================================
// Package.json extraction
// ============================================

function extractFromPackageJson(
  filePath: string,
  content: string,
  entities: ExtractedEntity[],
  relationships: ExtractedRelationship[]
): void {
  try {
    const pkg = JSON.parse(content);

    if (pkg.name) {
      entities.push({
        type: "package",
        name: pkg.name,
        description: pkg.description || `Package: ${pkg.name}`,
        metadata: { version: pkg.version, isRoot: true },
      });
    }

    const allDeps = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
    };

    for (const [depName, depVersion] of Object.entries(allDeps)) {
      entities.push({
        type: "package",
        name: depName,
        description: `Dependency: ${depName}@${depVersion}`,
        metadata: {
          version: depVersion,
          isDev: depName in (pkg.devDependencies || {}),
        },
      });

      // Create depends_on relationship from the project package to the dependency
      if (pkg.name) {
        relationships.push({
          fromName: pkg.name,
          fromType: "package",
          toName: depName,
          toType: "package",
          type: "depends_on",
          metadata: { version: depVersion },
        });
      }
    }
  } catch {
    // Not valid JSON — skip
  }
}

// ============================================
// Code extraction (functions/classes from source)
// ============================================

function extractFunctionsFromCode(
  filePath: string,
  content: string,
  entities: ExtractedEntity[],
  relationships: ExtractedRelationship[]
): void {
  // Extract exported function/class names with simple regex
  // This is intentionally lightweight — not a full AST parse
  const exportPatterns = [
    /export\s+(?:async\s+)?function\s+(\w+)/g,
    /export\s+(?:default\s+)?class\s+(\w+)/g,
    /export\s+const\s+(\w+)\s*=/g,
  ];

  for (const pattern of exportPatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const name = match[1];
      if (name && name.length > 1) {
        entities.push({
          type: "function",
          name: `${filePath}::${name}`,
          description: `Exported symbol in ${basename(filePath)}`,
          metadata: { filePath, symbolName: name },
        });

        // File contains function
        relationships.push({
          fromName: filePath,
          fromType: "file",
          toName: `${filePath}::${name}`,
          toType: "function",
          type: "contains",
        });
      }
    }
  }

  // Extract import sources for dependency tracking
  const importPattern = /(?:import|require)\s*\(?['"]([^'"]+)['"]\)?/g;
  let importMatch: RegExpExecArray | null;
  while ((importMatch = importPattern.exec(content)) !== null) {
    const source = importMatch[1];
    if (source && !source.startsWith(".") && !source.startsWith("/")) {
      // External package import
      const pkgName = source.startsWith("@")
        ? source.split("/").slice(0, 2).join("/")
        : source.split("/")[0];

      relationships.push({
        fromName: filePath,
        fromType: "file",
        toName: pkgName,
        toType: "package",
        type: "depends_on",
        metadata: { importSource: source },
      });
    }
  }
}

// ============================================
// Command extraction
// ============================================

function extractFromCommand(
  command: string,
  result: string,
  entities: ExtractedEntity[],
  relationships: ExtractedRelationship[]
): void {
  // Git commit from command line
  if (command.includes("git commit")) {
    const msgMatch = command.match(/-m\s+["']([^"']+)["']/);
    if (msgMatch) {
      entities.push({
        type: "decision",
        name: msgMatch[1].slice(0, 120),
        description: `Git commit via command: ${msgMatch[1]}`,
        metadata: { command },
      });
    }
  }

  // Package install commands
  if (
    command.includes("npm install") ||
    command.includes("bun add") ||
    command.includes("bun install") ||
    command.includes("yarn add") ||
    command.includes("pnpm add")
  ) {
    // Try to extract package names from the command
    const parts = command.split(/\s+/);
    const cmdIdx = parts.findIndex(
      (p) => p === "install" || p === "add" || p === "i"
    );
    if (cmdIdx >= 0) {
      for (let i = cmdIdx + 1; i < parts.length; i++) {
        const arg = parts[i];
        // Skip flags
        if (arg.startsWith("-")) continue;
        if (arg.length > 0) {
          entities.push({
            type: "package",
            name: arg,
            description: `Installed package: ${arg}`,
            metadata: { installedVia: command.split(/\s+/)[0] },
          });
        }
      }
    }
  }

  // Directory creation
  if (command.includes("mkdir")) {
    const parts = command.split(/\s+/);
    for (const part of parts) {
      if (part !== "mkdir" && !part.startsWith("-") && part.length > 0) {
        entities.push({
          type: "file",
          name: part,
          description: "Created directory",
          metadata: { isDirectory: true },
        });
      }
    }
  }
}

// ============================================
// User correction / preference detection
// ============================================

/**
 * Detect if a user message contains a correction or preference statement.
 * Call this from the memory manager when processing user messages.
 */
export function extractPreferencesFromMessage(
  message: string
): ExtractionResult {
  const entities: ExtractedEntity[] = [];
  const relationships: ExtractedRelationship[] = [];

  const lowerMessage = message.toLowerCase();

  // Preference indicators
  const prefPhrases = [
    "i prefer",
    "always use",
    "never use",
    "don't use",
    "use this instead",
    "i like",
    "i want",
    "please always",
    "please never",
    "remember that",
    "note that",
  ];

  for (const phrase of prefPhrases) {
    if (lowerMessage.includes(phrase)) {
      entities.push({
        type: "preference",
        name: message.slice(0, 120),
        description: `User preference: ${message}`,
        metadata: { trigger: phrase, fullMessage: message },
      });
      break; // Only one preference entity per message
    }
  }

  // Correction indicators (user is fixing agent behavior)
  const correctionPhrases = [
    "no, ",
    "that's wrong",
    "actually,",
    "not like that",
    "instead,",
    "you should have",
    "the correct",
    "fix this",
  ];

  for (const phrase of correctionPhrases) {
    if (lowerMessage.includes(phrase)) {
      entities.push({
        type: "preference",
        name: `correction: ${message.slice(0, 100)}`,
        description: `User correction: ${message}`,
        metadata: { isCorrection: true, fullMessage: message },
      });
      break;
    }
  }

  return { entities, relationships };
}

// ============================================
// Feedback loop prevention
// ============================================

/**
 * Strip previously-injected memory context from a message before extraction.
 * Without this, the extractor re-learns its own injections and memory grows unboundedly.
 *
 * Removes:
 *   - [Memory Context]...[/Memory Context] blocks
 *   - "What I know about this user:" paragraphs
 *   - [Memory]...[/Memory] blocks (from recallAsText)
 *   - Profile: ... lines from auto-inject
 */
export function stripInjectedContext(message: string): string {
  return message
    .replace(/\[Memory Context\][\s\S]*?\[\/Memory Context\]/g, "")
    .replace(/\[Memory\][\s\S]*?(?=\n\n|$)/g, "")
    .replace(/What I know about this user:[\s\S]*?(?=\n\n|$)/g, "")
    .replace(/^Profile:.*$/gm, "")
    .replace(/^Relevant memories:\n(?:- .*\n?)*/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
