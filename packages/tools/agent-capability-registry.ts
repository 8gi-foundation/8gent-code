/**
 * Capability interface representing an agent's capability.
 */
interface Capability {
  id: string;
  description: string;
  inputs: string[];
  outputs: string[];
  tags: string[];
  dependencies: string[];
}

/**
 * Registry interface containing all registered capabilities.
 */
interface Registry {
  capabilities: Record<string, Capability>;
}

/**
 * Registers a new capability in the registry.
 * @param registry The registry object.
 * @param capabilityId The unique ID of the capability.
 * @param options The capability options including description, inputs, outputs, and tags.
 */
function register(registry: Registry, capabilityId: string, options: { description: string; inputs: string[]; outputs: string[]; tags: string[] }): void {
  registry.capabilities[capabilityId] = {
    id: capabilityId,
    description: options.description,
    inputs: options.inputs,
    outputs: options.outputs,
    tags: options.tags,
    dependencies: []
  };
}

/**
 * Finds capabilities matching a query by description or tags.
 * @param registry The registry object.
 * @param query The search query.
 * @returns Array of matching capabilities.
 */
function find(registry: Registry, query: string): Capability[] {
  return Object.values(registry.capabilities).filter(cap => 
    cap.description.toLowerCase().includes(query.toLowerCase()) || 
    cap.tags.some(tag => tag.toLowerCase().includes(query.toLowerCase()))
  );
}

/**
 * Resolves a capability chain to achieve a goal.
 * @param registry The registry object.
 * @param goal The goal description to achieve.
 * @returns Array of capabilities in the chain.
 */
function resolve(registry: Registry, goal: string): Capability[] {
  const candidates = find(registry, goal);
  if (candidates.length === 0) return [];
  const result: Capability[] = [...candidates];
  const visited = new Set<string>();
  for (const cap of candidates) {
    const queue: string[] = [...cap.dependencies];
    while (queue.length > 0) {
      const depId = queue.shift()!;
      if (visited.has(depId)) continue;
      visited.add(depId);
      const depCap = registry.capabilities[depId];
      if (depCap) {
        result.push(depCap);
        queue.push(...depCap.dependencies);
      }
    }
  }
  return result;
}

/**
 * Returns required capabilities for a given capability.
 * @param registry The registry object.
 * @param capabilityId The capability ID.
 * @returns Array of dependency capability IDs.
 */
function dependencies(registry: Registry, capabilityId: string): string[] {
  return registry.capabilities[capabilityId]?.dependencies || [];
}

/**
 * Renders the registry as a formatted catalog.
 * @param registry The registry object.
 * @returns Formatted string of capabilities.
 */
function renderRegistry(registry: Registry): string {
  return Object.entries(registry.capabilities)
    .map(([id, cap]) => 
      `Capability: ${id}\n  Description: ${cap.description}\n  Tags: ${cap.tags.join(', ')}\n  Dependencies: ${cap.dependencies.join(', ')}`
    )
    .join('\n\n');
}

export { register, find, resolve, dependencies, renderRegistry };