/**
 * Capability Catalog - Formal capability definitions with alias resolution
 *
 * Replaces freeform string matching in agent-mesh.ts findByCapability()
 * with a structured catalog that normalizes "code" vs "coding" vs "code-generation"
 * to canonical capability IDs like "code:generate".
 *
 * Usage:
 *   const catalog = new CapabilityCatalog()
 *   catalog.resolve("coding")        // -> CapabilityDef { id: "code:generate", ... }
 *   catalog.validate(["coding", "foo"]) // -> { valid: ["coding"], unknown: ["foo"] }
 */

// MARK: - Types

export interface CapabilityDef {
  id: string           // e.g., "code:generate"
  category: string     // e.g., "code"
  name: string         // Human readable
  description: string
  aliases: string[]    // Alternative names resolving to this ID
}

// MARK: - Catalog

export class CapabilityCatalog {
  private capabilities = new Map<string, CapabilityDef>()
  private aliasIndex = new Map<string, string>() // alias -> id

  constructor() {
    this.loadBuiltins()
  }

  register(def: CapabilityDef): void {
    this.capabilities.set(def.id, def)
    for (const alias of def.aliases) {
      this.aliasIndex.set(alias, def.id)
    }
  }

  resolve(input: string): CapabilityDef | undefined {
    // Check by canonical ID first
    const direct = this.capabilities.get(input)
    if (direct) return direct

    // Then check alias index
    const resolvedId = this.aliasIndex.get(input)
    if (resolvedId) return this.capabilities.get(resolvedId)

    return undefined
  }

  validate(capabilities: string[]): { valid: string[]; unknown: string[] } {
    const valid: string[] = []
    const unknown: string[] = []

    for (const cap of capabilities) {
      if (this.resolve(cap)) {
        valid.push(cap)
      } else {
        unknown.push(cap)
      }
    }

    return { valid, unknown }
  }

  findBestMatch(
    required: string[],
    agents: Array<{ id: string; capabilities: string[] }>
  ): Array<{ agentId: string; score: number; matched: string[]; missing: string[] }> {
    // Resolve required capabilities to canonical IDs
    const requiredIds = required.map(r => this.resolve(r)?.id).filter(Boolean) as string[]

    const results = agents.map(agent => {
      // Resolve agent capabilities to canonical IDs (dedup)
      const agentCapIds = new Set<string>()
      for (const cap of agent.capabilities) {
        const resolved = this.resolve(cap)
        if (resolved) agentCapIds.add(resolved.id)
      }

      const matched: string[] = []
      const missing: string[] = []

      for (const reqId of requiredIds) {
        if (agentCapIds.has(reqId)) {
          matched.push(reqId)
        } else {
          missing.push(reqId)
        }
      }

      return {
        agentId: agent.id,
        score: matched.length,
        matched,
        missing,
      }
    })

    // Sort by score descending
    results.sort((a, b) => b.score - a.score)

    return results
  }

  listByCategory(category: string): CapabilityDef[] {
    const results: CapabilityDef[] = []
    for (const def of this.capabilities.values()) {
      if (def.category === category) {
        results.push(def)
      }
    }
    return results
  }

  // MARK: - Built-in capabilities

  private loadBuiltins(): void {
    const builtins: CapabilityDef[] = [
      // Code
      {
        id: "code:generate",
        category: "code",
        name: "Generate Code",
        description: "Generate code from specs",
        aliases: ["coding", "write-code"],
      },
      {
        id: "code:review",
        category: "code",
        name: "Code Review",
        description: "Review code for quality",
        aliases: ["review"],
      },
      {
        id: "code:refactor",
        category: "code",
        name: "Refactor Code",
        description: "Restructure code",
        aliases: ["refactoring"],
      },
      {
        id: "code:debug",
        category: "code",
        name: "Debug Code",
        description: "Find and fix bugs",
        aliases: ["debugging", "bugfix"],
      },

      // Test
      {
        id: "test:unit",
        category: "test",
        name: "Unit Testing",
        description: "Write and run unit tests",
        aliases: ["unit-test", "testing"],
      },
      {
        id: "test:integration",
        category: "test",
        name: "Integration Testing",
        description: "Integration testing",
        aliases: ["integration-test"],
      },
      {
        id: "test:e2e",
        category: "test",
        name: "End-to-End Testing",
        description: "End-to-end testing",
        aliases: ["end-to-end"],
      },

      // Infrastructure
      {
        id: "infra:deploy",
        category: "infra",
        name: "Deploy",
        description: "Deploy services",
        aliases: ["deployment", "ship"],
      },
      {
        id: "infra:monitor",
        category: "infra",
        name: "Monitor",
        description: "Monitor systems",
        aliases: ["monitoring", "observability"],
      },
      {
        id: "infra:config",
        category: "infra",
        name: "Configure",
        description: "Configure infrastructure",
        aliases: ["configuration"],
      },

      // Data
      {
        id: "data:query",
        category: "data",
        name: "Query Data",
        description: "Query data stores",
        aliases: ["sql", "database"],
      },
      {
        id: "data:transform",
        category: "data",
        name: "Transform Data",
        description: "Transform data",
        aliases: ["etl", "data-pipeline"],
      },
      {
        id: "data:visualize",
        category: "data",
        name: "Visualize Data",
        description: "Visualize data",
        aliases: ["charts", "graphs"],
      },

      // Documentation
      {
        id: "doc:write",
        category: "doc",
        name: "Write Documentation",
        description: "Write documentation",
        aliases: ["documentation", "docs"],
      },
      {
        id: "doc:review",
        category: "doc",
        name: "Review Documentation",
        description: "Review documentation",
        aliases: ["doc-review"],
      },

      // Security
      {
        id: "security:scan",
        category: "security",
        name: "Security Scan",
        description: "Scan for vulnerabilities",
        aliases: ["vulnerability-scan"],
      },
      {
        id: "security:audit",
        category: "security",
        name: "Security Audit",
        description: "Security audit",
        aliases: ["audit"],
      },
    ]

    for (const def of builtins) {
      this.register(def)
    }
  }
}
