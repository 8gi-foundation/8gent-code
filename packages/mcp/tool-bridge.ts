/**
 * MCP Tool Bridge
 *
 * Converts MCP tool schemas into Vercel AI SDK tool() objects.
 * Namespaces tools as mcp__{server}__{tool} to avoid collisions.
 */

import { tool } from "ai";
import { z } from "zod";
import type { ToolSet } from "ai";
import type { MCPClient } from "./client";

// ── Types ────────────────────────────────────────────────────────

export interface MCPToolSchema {
  name: string;
  description?: string;
  inputSchema?: {
    type: string;
    properties?: Record<string, any>;
    required?: string[];
  };
}

// ── Schema Converter ─────────────────────────────────────────────

/**
 * Convert a JSON Schema properties object to a Zod schema.
 * Handles basic types (string, number, boolean, integer, array, object).
 * Falls back to z.any() for unknown types.
 */
function jsonSchemaToZod(properties: Record<string, any>, required: string[] = []): z.ZodObject<any> {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, prop] of Object.entries(properties)) {
    let field: z.ZodTypeAny;

    switch (prop.type) {
      case "string":
        field = z.string();
        break;
      case "number":
      case "integer":
        field = z.number();
        break;
      case "boolean":
        field = z.boolean();
        break;
      case "array":
        field = z.array(z.any());
        break;
      case "object":
        if (prop.properties) {
          field = jsonSchemaToZod(prop.properties, prop.required || []);
        } else {
          field = z.record(z.any());
        }
        break;
      default:
        field = z.any();
    }

    if (prop.description) {
      field = field.describe(prop.description);
    }

    if (!required.includes(key)) {
      field = field.optional();
    }

    shape[key] = field;
  }

  return z.object(shape);
}

// ── Bridge ───────────────────────────────────────────────────────

/**
 * Build a namespace key for an MCP tool.
 * Format: mcp__{serverName}__{toolName}
 */
export function mcpToolKey(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

/**
 * Parse a namespaced tool key back into server + tool name.
 * Returns null if the key doesn't match the mcp__*__* pattern.
 */
export function parseMcpToolKey(key: string): { server: string; tool: string } | null {
  const match = key.match(/^mcp__([^_]+)__(.+)$/);
  if (!match) return null;
  return { server: match[1], tool: match[2] };
}

/**
 * Convert discovered MCP tools from a server into AI SDK ToolSet entries.
 * Each tool calls back through the MCPClient to execute on the remote server.
 */
export function bridgeTools(
  serverName: string,
  tools: MCPToolSchema[],
  client: MCPClient,
): ToolSet {
  const result: ToolSet = {};

  for (const mcpTool of tools) {
    const key = mcpToolKey(serverName, mcpTool.name);

    // Build Zod input schema from MCP JSON Schema
    let inputSchema: z.ZodTypeAny;
    if (mcpTool.inputSchema?.properties) {
      inputSchema = jsonSchemaToZod(
        mcpTool.inputSchema.properties,
        mcpTool.inputSchema.required || [],
      );
    } else {
      inputSchema = z.object({});
    }

    const description = mcpTool.description
      ? `[MCP:${serverName}] ${mcpTool.description}`
      : `[MCP:${serverName}] ${mcpTool.name}`;

    result[key] = tool({
      description,
      // TODO: NemoClaw permission check hook point
      // Before execute, check policyEngine.evaluate("mcp", { server, tool, args })
      inputSchema: inputSchema as z.ZodObject<any>,
      execute: async (args: Record<string, unknown>) => {
        const mcpResult = await client.callTool(serverName, mcpTool.name, args);
        // Flatten MCP content array to string for AI SDK
        if (!mcpResult?.content) return "No result";
        return mcpResult.content
          .map((c: any) => {
            if (c.type === "text") return c.text || "";
            if (c.type === "image") return `[Image: ${c.mimeType || "image"}]`;
            return `[${c.type}]`;
          })
          .join("\n");
      },
    });
  }

  return result;
}
