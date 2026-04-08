# Quarantine: prompt-templates

**Status:** Quarantine review
**File:** `packages/eight/prompt-templates.ts`
**Branch:** `quarantine/prompt-templates`

---

## What this adds

A zero-dependency `PromptTemplate` class with Handlebars-inspired syntax for composing Eight agent prompts programmatically instead of via raw string concatenation.

---

## Syntax

| Syntax | Purpose |
|--------|---------|
| `{{variable}}` | Interpolation - dot-paths supported (`{{user.name}}`) |
| `{{#if condition}}...{{/if}}` | Conditional block - truthy check |
| `{{#unless condition}}...{{/unless}}` | Inverted conditional |
| `{{#each items}}...{{/each}}` | Loop over array |
| `{{@index}}` `{{@first}}` `{{@last}}` | Loop position metadata |
| `{{> partial_name}}` | Include a registered partial |

---

## Public API

### `PromptTemplate`

```ts
const tpl = new PromptTemplate(source, options?)
tpl.render(context)       // -> string
tpl.validate()            // -> ValidationResult
tpl.withPartial(name, src) // -> new PromptTemplate (immutable)
tpl.toString()            // -> raw source
```

Options:
- `strict: boolean` - throw on unresolved variables or missing partials (default: false)
- `partials: Record<string, string>` - pre-registered partial templates

### `ValidationResult`

```ts
{
  valid: boolean
  errors: string[]      // syntax/structural errors
  variables: string[]   // all referenced variable names
  partials: string[]    // all referenced partial names
}
```

### Built-in templates

| Export | Purpose | Required variables |
|--------|---------|-------------------|
| `SYSTEM_PROMPT_TEMPLATE` | Agent system prompt | `agent_name`, `model`, `capabilities`, `user_name` |
| `TASK_DELEGATION_TEMPLATE` | Sub-agent task handoff | `task`, `parent_agent`, `tools` |
| `REFLECTION_TEMPLATE` | Post-session self-eval | `session_id`, `actions`, `goal` |
| `MEMORY_INJECTION_TEMPLATE` | Memory segment | `memories` |
| `ERROR_RECOVERY_TEMPLATE` | Error + retry prompt | `error_message`, `failed_action`, `context` |
| `CODE_REVIEW_TEMPLATE` | PR review | `diff`, `repo`, `branch` |

### `renderBuiltin(name, context)`

Convenience function to render any named built-in directly.

---

## Design decisions

- **Zero dependencies** - pure TypeScript, no external parser.
- **Immutable** - `withPartial()` returns a new instance; original is never mutated.
- **Stack-based context** - nested scopes (each/if blocks) push onto a context stack; inner scopes inherit outer variables.
- **Strict mode opt-in** - by default, unresolved variables render as empty string to avoid noisy prompts.
- **Falsy semantics** - `null`, `undefined`, `""`, `0`, `false`, `[]` are all falsy for `#if`/`#unless`.

---

## Integration notes

- Replaces ad hoc string interpolation in `packages/eight/prompts/system-prompt.ts`.
- Partials can be used to compose shared segments (memory block, tool list, etc.).
- `validate()` should be called at build/test time on all templates, not at runtime.
- No changes to existing files required - this is additive.

---

## What this does NOT do

- No HTML escaping (prompts are plain text, not HTML).
- No computed expressions (`{{a + b}}` is not supported - use pre-computed context).
- No async helpers.
- No whitespace control (`{{{-` strip syntax).

---

## Checklist for promotion from quarantine

- [ ] Unit tests written in `packages/eight/__tests__/prompt-templates.test.ts`
- [ ] `system-prompt.ts` migrated to use `SYSTEM_PROMPT_TEMPLATE`
- [ ] `reflection.ts` migrated to use `REFLECTION_TEMPLATE`
- [ ] Validate call added to CI / build script
- [ ] CHANGELOG.md entry added under `[Unreleased]`
