# Quarantine: mini-test-runner

## What

Self-contained minimal test runner for validating quarantine tools before promotion into the main tool registry. Provides `describe`, `it`, `expect`, `beforeEach`, `afterEach`, and `run` - no external dependencies, no test framework required.

## File

`packages/tools/mini-test-runner.ts` (~145 lines)

## Status

**quarantine** - new file, untested in CI, not yet wired into tool registry.

## API

```ts
import { describe, it, expect, beforeEach, afterEach, run } from './packages/tools/mini-test-runner.ts';

describe('MyTool', () => {
  let value = 0;

  beforeEach(() => { value = 0; });
  afterEach(() => { value = -1; });

  it('increments', () => {
    value += 1;
    expect(value).toBe(1);
  });

  it('equals by structure', () => {
    expect({ a: 1 }).toEqual({ a: 1 });
  });

  it('catches throws', () => {
    expect(() => { throw new Error('boom'); }).toThrow('boom');
  });
});

const allPassed = await run();
// stdout: pass/fail per test, summary line
// returns: true if 0 failures
```

## Matchers

| Matcher | What it checks |
|---------|----------------|
| `.toBe(val)` | `Object.is` strict equality |
| `.toEqual(val)` | Deep equality via JSON serialisation |
| `.toThrow(msg?)` | Function throws, optionally matching message substring |
| `.toBeTruthy()` | Value is truthy |
| `.toBeFalsy()` | Value is falsy |
| `.not.toBe(val)` | Negation prefix for all matchers |

## Hooks

- `beforeEach` / `afterEach` are scoped to the enclosing `describe` block and inherited by nested suites.

## Integration path

- [ ] Add exports to `packages/tools/index.ts`
- [ ] Use this runner to write validation tests for other quarantine tools before promoting them
- [ ] Add to CI as a lightweight smoke-test harness for `quarantine/` tooling
- [ ] Consider adding `beforeAll` / `afterAll` if async setup becomes needed
