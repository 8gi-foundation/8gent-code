/**
 * 8gent Toolshed - Capability Discovery
 *
 * Agents use this to find tools without loading them all into context.
 */

import type { Tool, Capability, Permission } from "../../types";
import { getAllTools, getTool } from "./register";

export interface ToolSummary {
  name: string;
  description: string;
  capabilities: Capability[];
  permissions: Permission[];
}

export interface DiscoveryQuery {
  capability?: Capability;
  permission?: Permission;
  namePattern?: string;
}

/**
 * List tools matching a capability
 */
export function listToolsByCapability(capability: Capability): ToolSummary[] {
  return getAllTools()
    .filter(tool => tool.capabilities.includes(capability))
    .map(toSummary);
}

/**
 * List tools matching a permission
 */
export function listToolsByPermission(permission: Permission): ToolSummary[] {
  return getAllTools()
    .filter(tool => tool.permissions.includes(permission))
    .map(toSummary);
}

/**
 * Search tools by name pattern
 */
export function searchTools(pattern: string): ToolSummary[] {
  const regex = new RegExp(pattern, "i");
  return getAllTools()
    .filter(tool => regex.test(tool.name) || regex.test(tool.description))
    .map(toSummary);
}

/**
 * Query tools with multiple filters
 */
export function queryTools(query: DiscoveryQuery): ToolSummary[] {
  let results = getAllTools();

  if (query.capability) {
    results = results.filter(t => t.capabilities.includes(query.capability!));
  }

  if (query.permission) {
    results = results.filter(t => t.permissions.includes(query.permission!));
  }

  if (query.namePattern) {
    const regex = new RegExp(query.namePattern, "i");
    results = results.filter(t => regex.test(t.name) || regex.test(t.description));
  }

  return results.map(toSummary);
}

/**
 * Get tool details (for agent to understand inputs/outputs)
 */
export function getToolDetails(name: string): Tool | null {
  return getTool(name) || null;
}

/**
 * Get all capabilities currently available
 */
export function listCapabilities(): Capability[] {
  const caps = new Set<Capability>();
  for (const tool of getAllTools()) {
    for (const cap of tool.capabilities) {
      caps.add(cap);
    }
  }
  return Array.from(caps);
}

/**
 * Convert tool to summary (for listing without full details)
 */
function toSummary(tool: Tool): ToolSummary {
  return {
    name: tool.name,
    description: tool.description,
    capabilities: tool.capabilities,
    permissions: tool.permissions,
  };
}

/**
 * Format tools for agent context (minimal token usage)
 */
export function formatForAgent(tools: ToolSummary[]): string {
  return tools
    .map(t => `- ${t.name}: ${t.description}`)
    .join("\n");
}
