/**
 * 8gent Code - Tool Registry
 *
 * Dynamic tool discovery and registration system.
 * Stripe-inspired architecture with capability-based routing.
 *
 * Tools register themselves, capabilities are auto-discovered,
 * and the planner queries for tools matching required capabilities.
 */

import type { Tool, Capability, Permission } from "../../types";

interface ToolRegistration {
  tool: Tool;
  registeredAt: Date;
  usageCount: number;
  totalTokensSaved: number;
}

interface CapabilityIndex {
  capability: Capability;
  tools: string[]; // Tool names
}

/**
 * The Tool Registry - central hub for all 8gent tools
 */
class ToolRegistry {
  private tools: Map<string, ToolRegistration> = new Map();
  private capabilityIndex: Map<Capability, string[]> = new Map();
  private permissionIndex: Map<Permission, string[]> = new Map();

  /**
   * Register a tool
   */
  register(tool: Tool): void {
    // Validate tool
    this.validateTool(tool);

    // Check for duplicates
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool '${tool.name}' is already registered`);
    }

    // Store tool
    this.tools.set(tool.name, {
      tool,
      registeredAt: new Date(),
      usageCount: 0,
      totalTokensSaved: 0,
    });

    // Index by capabilities
    for (const cap of tool.capabilities) {
      const existing = this.capabilityIndex.get(cap) || [];
      this.capabilityIndex.set(cap, [...existing, tool.name]);
    }

    // Index by permissions
    for (const perm of tool.permissions) {
      const existing = this.permissionIndex.get(perm) || [];
      this.permissionIndex.set(perm, [...existing, tool.name]);
    }
  }

  /**
   * Unregister a tool
   */
  unregister(name: string): boolean {
    const registration = this.tools.get(name);
    if (!registration) return false;

    // Remove from capability index
    for (const cap of registration.tool.capabilities) {
      const tools = this.capabilityIndex.get(cap) || [];
      this.capabilityIndex.set(cap, tools.filter(t => t !== name));
    }

    // Remove from permission index
    for (const perm of registration.tool.permissions) {
      const tools = this.permissionIndex.get(perm) || [];
      this.permissionIndex.set(perm, tools.filter(t => t !== name));
    }

    this.tools.delete(name);
    return true;
  }

  /**
   * Get a tool by name
   */
  get(name: string): Tool | undefined {
    return this.tools.get(name)?.tool;
  }

  /**
   * Find tools by capability
   */
  findByCapability(capability: Capability): Tool[] {
    const toolNames = this.capabilityIndex.get(capability) || [];
    return toolNames
      .map(name => this.tools.get(name)?.tool)
      .filter((t): t is Tool => t !== undefined);
  }

  /**
   * Find tools matching multiple capabilities (AND)
   */
  findByCapabilities(capabilities: Capability[]): Tool[] {
    if (capabilities.length === 0) return this.getAllTools();

    const toolSets = capabilities.map(cap =>
      new Set(this.capabilityIndex.get(cap) || [])
    );

    // Intersection of all sets
    const intersection = toolSets.reduce((acc, set) => {
      return new Set([...acc].filter(x => set.has(x)));
    });

    return [...intersection]
      .map(name => this.tools.get(name)?.tool)
      .filter((t): t is Tool => t !== undefined);
  }

  /**
   * Find tools by required permissions
   */
  findByPermissions(permissions: Permission[]): Tool[] {
    const toolNames = new Set<string>();
    for (const perm of permissions) {
      const tools = this.permissionIndex.get(perm) || [];
      tools.forEach(t => toolNames.add(t));
    }

    return [...toolNames]
      .map(name => this.tools.get(name)?.tool)
      .filter((t): t is Tool => t !== undefined);
  }

  /**
   * Get all registered tools
   */
  getAllTools(): Tool[] {
    return Array.from(this.tools.values()).map(r => r.tool);
  }

  /**
   * Get all registered capabilities
   */
  getAllCapabilities(): Capability[] {
    return [...this.capabilityIndex.keys()];
  }

  /**
   * Get tool count
   */
  get size(): number {
    return this.tools.size;
  }

  /**
   * Record tool usage
   */
  recordUsage(name: string, tokensSaved: number = 0): void {
    const registration = this.tools.get(name);
    if (registration) {
      registration.usageCount++;
      registration.totalTokensSaved += tokensSaved;
    }
  }

  /**
   * Get usage stats for a tool
   */
  getStats(name: string): { usageCount: number; totalTokensSaved: number } | undefined {
    const registration = this.tools.get(name);
    if (!registration) return undefined;
    return {
      usageCount: registration.usageCount,
      totalTokensSaved: registration.totalTokensSaved,
    };
  }

  /**
   * Get overall registry stats
   */
  getRegistryStats(): {
    toolCount: number;
    capabilityCount: number;
    totalUsage: number;
    totalTokensSaved: number;
    topTools: { name: string; usage: number }[];
  } {
    const registrations = Array.from(this.tools.values());
    const totalUsage = registrations.reduce((sum, r) => sum + r.usageCount, 0);
    const totalTokensSaved = registrations.reduce((sum, r) => sum + r.totalTokensSaved, 0);

    const topTools = registrations
      .sort((a, b) => b.usageCount - a.usageCount)
      .slice(0, 5)
      .map(r => ({ name: r.tool.name, usage: r.usageCount }));

    return {
      toolCount: this.tools.size,
      capabilityCount: this.capabilityIndex.size,
      totalUsage,
      totalTokensSaved,
      topTools,
    };
  }

  /**
   * Validate tool structure
   */
  private validateTool(tool: Tool): void {
    if (!tool.name || typeof tool.name !== "string") {
      throw new Error("Tool must have a name");
    }
    if (!tool.description || typeof tool.description !== "string") {
      throw new Error("Tool must have a description");
    }
    if (!Array.isArray(tool.capabilities) || tool.capabilities.length === 0) {
      throw new Error("Tool must have at least one capability");
    }
    if (!tool.inputSchema || typeof tool.inputSchema !== "object") {
      throw new Error("Tool must have an inputSchema");
    }
    if (!tool.execute || typeof tool.execute !== "function") {
      throw new Error("Tool must have an execute function");
    }
  }

  /**
   * Export registry to JSON (for debugging/persistence)
   */
  toJSON(): object {
    return {
      tools: Array.from(this.tools.entries()).map(([name, reg]) => ({
        name,
        description: reg.tool.description,
        capabilities: reg.tool.capabilities,
        permissions: reg.tool.permissions,
        usageCount: reg.usageCount,
        totalTokensSaved: reg.totalTokensSaved,
        registeredAt: reg.registeredAt.toISOString(),
      })),
      capabilityIndex: Object.fromEntries(this.capabilityIndex),
      stats: this.getRegistryStats(),
    };
  }

  /**
   * Clear all registrations
   */
  clear(): void {
    this.tools.clear();
    this.capabilityIndex.clear();
    this.permissionIndex.clear();
  }
}

// Singleton registry
let registryInstance: ToolRegistry | null = null;

export function getToolRegistry(): ToolRegistry {
  if (!registryInstance) {
    registryInstance = new ToolRegistry();
  }
  return registryInstance;
}

export function resetToolRegistry(): void {
  registryInstance?.clear();
  registryInstance = null;
}

// Re-export types
export type { Tool, Capability, Permission };
