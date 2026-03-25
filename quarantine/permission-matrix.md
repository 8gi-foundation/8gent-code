# permission-matrix

**Tool name:** permission-matrix
**Package:** `packages/permissions/permission-matrix.ts`
**Status:** quarantine

## Description

Role-based access control evaluator for agent authorization. Defines roles, resources, and actions. Supports wildcard matching (`*`), resource namespace prefixes (`workspace/*`), and recursive role inheritance. Provides a `PermissionMatrix` class with a `can(role, action, resource)` API and a pre-built `agentPermissionMatrix` suitable for agent policy enforcement.

## Capabilities

- `can(role, action, resource)` - boolean check with caching
- Wildcard actions and resources (`*`, `namespace/*`)
- Role inheritance (multiple parents, cycle-safe)
- `setRole()` - runtime role mutation
- `allowedActions(role, resource)` - introspection
- `listRoles()` - enumerate all defined roles

## Integration Path

1. Import into `packages/permissions/policy-engine.ts` as a supplementary evaluator alongside the existing YAML-based NemoClaw engine.
2. Wire into `packages/eight/agent.ts` tool dispatch - check `agentPermissionMatrix.can(role, 'execute', 'tools/'+toolName)` before invoking any tool.
3. Expose role assignment via onboarding preferences or `.8gent/config.json` under `"permissions": { "role": "agent" }`.
4. Add a `/permissions` TUI screen to inspect current role and allowed actions.

## Exit Criteria (to graduate from quarantine)

- [ ] Unit tests covering wildcard, inheritance, and cache invalidation
- [ ] Integrated into policy-engine.ts with at least one real enforcement point
- [ ] Benchmark: p95 `can()` latency < 0.1ms on a 20-role matrix
