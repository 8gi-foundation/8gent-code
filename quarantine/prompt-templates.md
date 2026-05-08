# Quarantine: prompt-templates

**Status:** Quarantine review
**File:** `packages/eight/prompt-templates.ts`
**Branch:** `quarantine/prompt-templates`

---

## What this adds

A zero-dependency `PromptTemplate` class with Handlebars-inspired syntax for composing Eight agent prompts programmatically rather than concatenating raw strings.

---

## Syntax

| Syntax | Purpose |
|--------|---------|
| `{{variable}}` | Interpolation - dot-paths supported (`{{user.name}}`) |
| `{{#if condition}}...{{/if}}` | Conditional block - truthy check |
| `{{#unless condition}}...{{/unless}}` | Inverted conditional |
| `{{#each items}}...{{/each}}` | Loop over array |
| `{{@index}}` `{{@first}}` `{{@last}}` | Loop position metadata (inside each) |
| `{{> partial_name}}` | Include a registered partial |

---

## Public API

### `PromptTemplate`

```ts
const tpl = new PromptTemplate(source, options?)
tpl.render(context)          // -> string
tpl.validate()               // -> ValidationResult
tpl.withPartial(name, src)   // -> new PromptTemplate (immutable)
tpl.toString()               // -> raw source
```

Options:
- `strict: boolean` - throw on unresolved variables or missing partials (default: false)
- `partials: Record<string, string>` - pre-registered partial templates

### `ValidationResult`

```ts
{
  valid: boolean
  errors: string[]      // syntax / structural errors
  variables: string[]   // all referenced variable paths
  partials: string[]    // all referenced partial names
}
```

### Built-in templates

| Export | Purpose | Required variables |
|--------|---------|-------------------|
| `SYSTEM_PROMPT_TEMPLATE` | Agent system prompt | `agent_name`, `model`, `capabilities`, `user_name` |
| `TASK_DELEGATION_TEMPLATE` | Sub-agent task handoff | `task`, `parent_agent`, `tools` |
| `REFLECTION_TEMPLATE` | Post-session self-eval | `session_id`, `goal`, `actions` |
| `MEMORY_INJECTION_TEMPLATE` | Memory segment insert | `memories` |
| `ERROR_RECOVERY_TEMPLATE` | Error + retry prompt | `error_message`, `failed_action`, `context` |
| `CODE_REVIEW_TEMPLATE` | PR review request | `diff`, `repo`, `branch` |

### `renderBuiltin(name, context)`

Convenience function. Renders any named built-in directly without holding a reference.

---

## Design decisions

- Zero dependencies - pure TypeScript, no external parser or template library.
- Immutable instances - `withPartial()` returns a new instance; original is never mutated.
- Stack-based context - nested scopes (each/if) push onto a context stack so inner scopes inherit outer variables.
- Strict mode opt-in - by default, unresolved variables emit empty string. Strict mode throws, useful in tests.
- Falsy semantics - `null`, `undefined`, `""`, `0`, `false`, `[]` are all falsy for conditionals.
- Dot-path resolution - `{{user.name}}` walks the object graph.

---

## What this does NOT do

- No HTML escaping (prompts are plain text).
- No computed expressions (`{{a + b}}` is not supported - pre-compute in context).
- No async helpers or filters.
- No whitespace control stripping syntax.

---

## Checklist for promotion from quarantine

- [ ] Unit tests in `packages/eight/__tests__/prompt-templates.test.ts`
- [ ] `system-prompt.ts` migrated to use `SYSTEM_PROMPT_TEMPLATE`
- [ ] `reflection.ts` migrated to use `REFLECTION_TEMPLATE`
- [ ] `validate()` called on all built-ins in CI
- [ ] CHANGELOG.md entry under `[Unreleased]`
