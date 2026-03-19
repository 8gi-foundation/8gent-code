/**
 * Tool Self-Registration — Decorator-based tool registry
 *
 * Tools declare themselves via the @registerTool decorator and are
 * auto-discovered at startup. The registry formats tools for the AI SDK
 * and filters by runtime availability.
 */

import { readdirSync } from "node:fs";
import { join, extname } from "node:path";

// ── Types ──────────────────────────────────────────────────────────────────

export interface JSONSchema {
  type: string;
  properties?: Record<string, any>;
  required?: string[];
  description?: string;
  [key: string]: any;
}

export interface ToolConfig {
  name: string;
  description: string;
  schema: JSONSchema;
  /** Optional guard — tool is only available when this returns true. */
  availableWhen?: () => boolean;
}

export interface RegisteredTool {
  config: ToolConfig;
  handler: (...args: any[]) => any;
  target: any;
  methodName: string;
}

// ── Decorator ──────────────────────────────────────────────────────────────

/**
 * Method decorator that registers a class method as an agent tool.
 *
 * @example
 * class MyTools {
 *   @registerTool({
 *     name: "read_file",
 *     description: "Read a file from disk",
 *     schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
 *   })
 *   readFile(args: { path: string }) { ... }
 * }
 */
export function registerTool(config: ToolConfig): MethodDecorator {
  return function (
    target: any,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) {
    const original = descriptor.value;

    if (typeof original !== "function") {
      throw new Error(
        `@registerTool can only decorate methods, got ${typeof original} for ${String(propertyKey)}`,
      );
    }

    ToolRegistry.register({
      config,
      handler: original,
      target,
      methodName: String(propertyKey),
    });

    return descriptor;
  };
}

// ── Registry ───────────────────────────────────────────────────────────────

export class ToolRegistry {
  private static tools: Map<string, RegisteredTool> = new Map();

  /** Register a tool. Overwrites if a tool with the same name exists. */
  static register(tool: RegisteredTool): void {
    ToolRegistry.tools.set(tool.config.name, tool);
  }

  /** Get all registered tools, regardless of availability. */
  static getAll(): RegisteredTool[] {
    return Array.from(ToolRegistry.tools.values());
  }

  /** Get only tools whose availableWhen guard returns true (or have no guard). */
  static getAvailable(): RegisteredTool[] {
    return ToolRegistry.getAll().filter((tool) => {
      if (!tool.config.availableWhen) return true;
      try {
        return tool.config.availableWhen();
      } catch {
        return false;
      }
    });
  }

  /** Find a tool by name. */
  static find(name: string): RegisteredTool | null {
    return ToolRegistry.tools.get(name) ?? null;
  }

  /**
   * Format all available tools for the AI SDK tool definitions.
   * Returns an array compatible with Vercel AI SDK's `tools` parameter.
   */
  static toModelTools(): any[] {
    return ToolRegistry.getAvailable().map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.config.name,
        description: tool.config.description,
        parameters: tool.config.schema,
      },
    }));
  }

  /** Clear all registered tools (useful for testing). */
  static clear(): void {
    ToolRegistry.tools.clear();
  }

  /**
   * Auto-discover and import tool files from a directory.
   * Looks for .ts and .js files and dynamically imports them.
   * The import side-effects (decorators executing) register the tools.
   */
  static async discoverTools(directory: string): Promise<number> {
    const validExtensions = new Set([".ts", ".js", ".mts", ".mjs"]);
    let imported = 0;

    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return 0;
    }

    for (const entry of entries) {
      const ext = extname(entry);
      if (!validExtensions.has(ext)) continue;
      // Skip test files and index files
      if (entry.includes(".test.") || entry.includes(".spec.") || entry === "index.ts" || entry === "index.js") {
        continue;
      }

      try {
        await import(join(directory, entry));
        imported++;
      } catch (err) {
        // Silently skip files that fail to import — they may have
        // missing dependencies or be non-tool modules.
        console.warn(`[ToolRegistry] Failed to import ${entry}:`, err);
      }
    }

    return imported;
  }
}
