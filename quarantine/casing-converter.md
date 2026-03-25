# Quarantine: casing-converter

## What

Self-contained string casing converter that tokenizes any casing convention and rebuilds it in the target format. Supports camelCase, snake_case, kebab-case, PascalCase, SCREAMING_SNAKE_CASE, and Title Case with auto-detection.

## File

`packages/tools/casing-converter.ts` (~130 lines)

## Status

**quarantine** - new file, untested in CI, not yet wired into tool registry.

## API

```ts
import {
  toCamel,
  toSnake,
  toKebab,
  toPascal,
  toScreamingSnake,
  toTitle,
  detectCase,
  convert,
} from './packages/tools/casing-converter.ts';

// Direct converters
toCamel("hello_world")          // "helloWorld"
toSnake("helloWorld")           // "hello_world"
toKebab("HelloWorld")           // "hello-world"
toPascal("hello-world")         // "HelloWorld"
toScreamingSnake("helloWorld")  // "HELLO_WORLD"
toTitle("hello_world")          // "Hello World"

// Auto-detect
detectCase("helloWorld")        // "camel"
detectCase("HELLO_WORLD")       // "screaming_snake"

// Generic converter
convert("hello_world", "camel") // "helloWorld"
convert("helloWorld", "kebab", "camel") // "hello-world"
```

## Supported conversions

| From \ To        | camel | snake | kebab | pascal | screaming_snake | title |
|-----------------|-------|-------|-------|--------|-----------------|-------|
| camelCase       | -     | yes   | yes   | yes    | yes             | yes   |
| snake_case      | yes   | -     | yes   | yes    | yes             | yes   |
| kebab-case      | yes   | yes   | -     | yes    | yes             | yes   |
| PascalCase      | yes   | yes   | yes   | -      | yes             | yes   |
| SCREAMING_SNAKE | yes   | yes   | yes   | yes    | -               | yes   |

## Integration path

- [ ] Add exports to `packages/tools/index.ts`
- [ ] Register as an agent-callable tool in `packages/eight/tools.ts`
- [ ] Add unit tests: round-trip each case through all conversions
- [ ] Wire into TUI as a `/case` command or inline code-action
- [ ] Consider batch mode: convert all identifiers in a file
