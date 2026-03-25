# fixture-builder

Builder pattern for creating test fixture objects.

## Requirements
- defineFixture(defaults) -> FixtureBuilder<T>
- builder.build(overrides?) -> T
- builder.buildMany(count, overrides?) -> T[]
- Supports nested fixtures
- TypeScript generics preserve the shape

## Status

Quarantine - pending review.

## Location

`packages/tools/fixture-builder.ts`
