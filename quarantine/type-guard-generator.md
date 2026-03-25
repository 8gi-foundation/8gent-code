# type-guard-generator

## Tool Name
`type-guard-generator`

## Description
Generates runtime TypeScript type guard functions (`isX()`) from interface and type alias
definitions. Parses source code, extracts field names and types, and emits narrowing functions
that safely validate unknown values at runtime. Handles optional fields, union types, string
literals, arrays, and nested objects.

## Status
`quarantine` - self-contained, not yet wired into the agent tool registry.

## Location
`packages/tools/type-guard-generator.ts`

## Public API

```typescript
generateGuard(interfaceCode: string): string
```

Takes TypeScript source containing one or more `interface` or `type = {}` definitions.
Returns generated `isX()` functions as a TypeScript string.

## Example

Input:
```typescript
interface User {
  id: number;
  name: string;
  role?: "admin" | "user";
  tags: string[];
}
```

Output:
```typescript
export function isUser(value: unknown): value is User {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (!(typeof v.id === "number")) return false;
  if (!(typeof v.name === "string")) return false;
  if (v.role !== undefined && !((v.role === "admin" || v.role === "user"))) return false;
  if (!(Array.isArray(v.tags))) return false;
  return true;
}
```

## Integration Path

1. Export from `packages/tools/index.ts`.
2. Register as an Eight tool definition in `packages/eight/tools.ts`.
3. Hook into code-generation: auto-generate `*.guards.ts` alongside interface files.
4. Optional: `8gent guard <file>` CLI subcommand.

## Constraints
- Requires valid TypeScript interface or type alias syntax.
- Nested types produce object checks only - no recursive guard calls.
- Generic types (e.g. `Foo<T>`) are not supported.
