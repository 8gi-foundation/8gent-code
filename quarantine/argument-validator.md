# argument-validator

**Status:** quarantine

## Description

Fluent argument validator for TypeScript functions. Provides chainable type checks, range validation, pattern matching, and descriptive error messages - without pulling in a heavy schema library.

Key behaviours:
- `check(value, 'paramName')` returns a `Validator<T>` instance
- Type guards: `.isString()`, `.isNumber()`, `.isBoolean()`, `.isArray()`, `.isDefined()`
- Length guards: `.minLength(n)`, `.maxLength(n)` - works on strings and arrays
- Numeric range: `.inRange(min, max)`
- Pattern matching: `.matches(regex)`
- Enum check: `.isOneOf(values)` - narrows the type to the union
- Escape hatch: `.satisfies(predicate, message?)`
- All methods accept an optional custom message as the last argument
- Validators are chainable; errors throw `ArgumentError` with param name + human-readable description
- `.get()` unwraps the validated value with its narrowed type

Exports:
- `check(value, name?)` - entry point, returns `Validator<T>`
- `ArgumentError` - extends `Error`, carries `param` and `message`

## Integration path

1. **Tool definitions** (`packages/eight/tools.ts`) - validate incoming tool arguments before executing; surface `ArgumentError` messages to the agent as structured feedback rather than crashes.
2. **Agent loop** (`packages/eight/agent.ts`) - wrap user-supplied config fields (model, temperature, maxTokens) with `check()` guards on session start.
3. **Permissions / policy engine** (`packages/permissions/policy-engine.ts`) - validate policy rule fields at load time; catch misconfigured YAML before it reaches execution.
4. **Public package API** - any exported function in `packages/` that accepts untrusted input can use `check()` instead of inline `if` guards.

## Promotion criteria

- [ ] Unit tests cover all guard methods plus chaining
- [ ] Integrated into at least one `packages/eight/` call site with measurable reduction in unhandled type errors
- [ ] `ArgumentError` surfaces cleanly in TUI error display (not raw stack trace)
- [ ] No runtime dependencies added - zero-dep file
