# test-fixture-builder

## Tool Name
`test-fixture-builder`

## Description
Builds test fixtures using a factory pattern with traits, sequences, and associations for consistent, composable test data generation. Supports:
- `defineFactory(name, defaults, traits)` - declare a factory with typed defaults and named traits
- `Factory.build(overrides, ...traits)` - produce a single fixture, merging traits and overrides
- `Factory.buildList(count, overrides, ...traits)` - produce N fixtures
- `Factory.seq()` - per-factory auto-incrementing integer for unique IDs
- `Factory.association(subFactory, overrides, ...traits)` - embed related fixtures
- `resetSequences()` - clear counters between tests

## Status
**quarantine** - standalone, no runtime dependencies, not yet wired into the agent tool registry.

## Integration Path
1. Add to `packages/tools/index.ts` exports once reviewed.
2. Register as a tool in `packages/eight/tools.ts` under the `test` capability group.
3. Wire into the agent harness so Eight can generate fixture data during test scaffolding tasks.
4. Consider adding a `createFromSchema(jsonSchema)` helper that auto-generates defaults from a JSON Schema definition.
