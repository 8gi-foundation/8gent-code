/**
 * 8gent Toolshed - Tool Registration
 */

import type {
	Capability,
	Permission,
	Tool,
	ToolCapabilityTier,
	ToolRegistration,
} from "../../types";

// In-memory registry (will be persisted to disk)
const tools: Map<string, Tool> = new Map();
const capabilityIndex: Map<Capability, Set<string>> = new Map();
const tierIndex: Map<ToolCapabilityTier, Set<string>> = new Map();

/**
 * Register a new tool with the toolshed.
 *
 * `registration.tiers` is required by the type system — TypeScript will refuse
 * to compile a tool that omits it. The runtime check below catches
 * dynamically-built registrations (e.g. via `as ToolRegistration` casts) so
 * untiered tools never reach the registry.
 */
export function registerTool(registration: ToolRegistration, executor: Tool["execute"]): void {
	if (!registration.tiers || registration.tiers.length === 0) {
		throw new Error(
			`[toolshed] Tool '${registration.name}' must declare at least one capability tier`,
		);
	}

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
		capabilityIndex.get(cap)?.add(tool.name);
	}

	// Index by tier
	for (const tier of tool.tiers) {
		if (!tierIndex.has(tier)) {
			tierIndex.set(tier, new Set());
		}
		tierIndex.get(tier)?.add(tool.name);
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

	// Remove from tier index
	for (const tier of tool.tiers) {
		tierIndex.get(tier)?.delete(name);
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
 * Get all tools that require a given tier.
 */
export function getToolsForTier(tier: ToolCapabilityTier): Tool[] {
	const names = tierIndex.get(tier);
	if (!names) return [];
	return Array.from(names)
		.map((n) => tools.get(n))
		.filter((t): t is Tool => t !== undefined);
}

/**
 * Clear all tools (for testing)
 */
export function clearRegistry(): void {
	tools.clear();
	capabilityIndex.clear();
	tierIndex.clear();
}
