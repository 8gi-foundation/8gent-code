/**
 * 8gent Toolshed - Tool Registration
 */

import type { Tool, ToolRegistration, Capability, Permission } from "../../types";

// In-memory registry (will be persisted to disk)
const tools: Map<string, Tool> = new Map();
const capabilityIndex: Map<Capability, Set<string>> = new Map();

/**
 * Register a new tool with the toolshed
 */
export function registerTool(registration: ToolRegistration, executor: Tool["execute"]): void {
  const tool: Tool = {
    ...registration,
    outputSchema: registration.outputSchema || { type: "object" },
    execute: executor,
  };

  tools.set(tool.name, tool);

  // Index by capability
  for (const cap of tool.capabilities) {
    if (!capabilityIndex.has(cap)) {
      capabilityIndex.set(cap, new Set());
    }
    capabilityIndex.get(cap)!.add(tool.name);
  }

  console.log(`[toolshed] Registered tool: ${tool.name}`);
}

/**
 * Unregister a tool
 */
export function unregisterTool(name: string): boolean {
  const tool = tools.get(name);
  if (!tool) return false;

  // Remove from capability index
  for (const cap of tool.capabilities) {
    capabilityIndex.get(cap)?.delete(name);
  }

  tools.delete(name);
  console.log(`[toolshed] Unregistered tool: ${name}`);
  return true;
}

/**
 * Get a tool by name
 */
export function getTool(name: string): Tool | undefined {
  return tools.get(name);
}

/**
 * Check if a tool exists
 */
export function hasTool(name: string): boolean {
  return tools.has(name);
}

/**
 * Get all registered tools
 */
export function getAllTools(): Tool[] {
  return Array.from(tools.values());
}

/**
 * Get tool count
 */
export function getToolCount(): number {
  return tools.size;
}

/**
 * Clear all tools (for testing)
 */
export function clearRegistry(): void {
  tools.clear();
  capabilityIndex.clear();
}
