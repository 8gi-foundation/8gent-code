/**
 * PermissionMatrix - role-based access control evaluator
 * Supports wildcard actions, resource namespaces, and role inheritance.
 */

export type Action = string;
export type Resource = string;

export interface RoleDefinition {
  /** Actions this role can perform. Use "*" for all actions. */
  allow: Array<`${Action}:${Resource}` | "*">;
  /** Roles this role inherits from (resolved recursively). */
  inherits?: string[];
}

export interface PermissionMatrixConfig {
  roles: Record<string, RoleDefinition>;
}

export class PermissionMatrix {
  private roles: Record<string, RoleDefinition>;
  private cache: Map<string, boolean> = new Map();

  constructor(config: PermissionMatrixConfig) {
    this.roles = config.roles;
  }

  /**
   * Check if a role can perform an action on a resource.
   * Resolves inheritance and wildcards.
   */
  can(roleName: string, action: Action, resource: Resource): boolean {
    const cacheKey = `${roleName}:${action}:${resource}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey)!;

    const result = this.evaluate(roleName, action, resource, new Set());
    this.cache.set(cacheKey, result);
    return result;
  }

  private evaluate(
    roleName: string,
    action: Action,
    resource: Resource,
    visited: Set<string>
  ): boolean {
    if (visited.has(roleName)) return false;
    visited.add(roleName);

    const role = this.roles[roleName];
    if (!role) return false;

    for (const entry of role.allow) {
      if (this.matchesEntry(entry, action, resource)) return true;
    }

    if (role.inherits) {
      for (const parent of role.inherits) {
        if (this.evaluate(parent, action, resource, visited)) return true;
      }
    }

    return false;
  }

  private matchesEntry(
    entry: string,
    action: Action,
    resource: Resource
  ): boolean {
    if (entry === "*") return true;

    const [entryAction, entryResource] = entry.split(":");
    const actionMatch = entryAction === "*" || entryAction === action;
    const resourceMatch =
      entryResource === "*" ||
      entryResource === resource ||
      (entryResource?.endsWith("/*") &&
        resource.startsWith(entryResource.slice(0, -2)));
    return actionMatch && resourceMatch;
  }

  /** Return all actions a role can perform on a resource. */
  allowedActions(roleName: string, resource: Resource): Action[] {
    const allActions = this.collectActions(roleName, new Set());
    return allActions.filter((a) => this.can(roleName, a, resource));
  }

  private collectActions(roleName: string, visited: Set<string>): Action[] {
    if (visited.has(roleName)) return [];
    visited.add(roleName);

    const role = this.roles[roleName];
    if (!role) return [];

    const actions: Action[] = [];
    for (const entry of role.allow) {
      if (entry === "*") return ["*"];
      const [action] = entry.split(":");
      if (action && !actions.includes(action)) actions.push(action);
    }

    if (role.inherits) {
      for (const parent of role.inherits) {
        for (const a of this.collectActions(parent, visited)) {
          if (!actions.includes(a)) actions.push(a);
        }
      }
    }

    return actions;
  }

  /** Add or update a role definition at runtime. Clears affected cache entries. */
  setRole(roleName: string, definition: RoleDefinition): void {
    this.roles[roleName] = definition;
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${roleName}:`)) this.cache.delete(key);
    }
  }

  /** List all defined role names. */
  listRoles(): string[] {
    return Object.keys(this.roles);
  }
}

// ---------------------------------------------------------------------------
// Example / default matrix for agent authorization
// ---------------------------------------------------------------------------
export const agentPermissionMatrix = new PermissionMatrix({
  roles: {
    guest: {
      allow: ["read:public/*"],
    },
    agent: {
      allow: ["read:*", "write:workspace/*", "execute:tools/*"],
      inherits: ["guest"],
    },
    admin: {
      allow: ["*"],
    },
    readonly: {
      allow: ["read:*"],
      inherits: ["guest"],
    },
  },
});
