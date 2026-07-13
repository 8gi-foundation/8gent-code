# Skill Manifest (SPEC)

Status: Step 1 of the third-party skill ecosystem (issue #2760). Shipped.

## Why

Skills accumulate (Principle 3), but today only ours do. A Frontier ecosystem is
open: someone we have never met ships a skill and a user installs it without fear.
Fearless install needs a declared, machine-checkable contract for every skill -
what it needs, what it grants, how it is entered - validated *before* the skill is
allowed to widen the running agent's capabilities. That contract is the manifest.

The manifest is the admission gate the later steps build on:

- Step 2 (capability scoping): a skill gets the capabilities it declares, nothing more.
- Step 3 (registry + `8gent skill install <name>`): the index validates each manifest before listing.
- Step 4 (quarantine lane): a new or updated skill runs read-only until its manifest is promoted.

## Shape

The manifest is projected from `SKILL.md` YAML frontmatter. Every field maps to an
existing or additive frontmatter key, so all bundled skills stay valid with no edits.

```yaml
---
name: deploy                       # required. install slug + disk filename stem.
description: Deploy the app         # recommended.
version: 1.2.0                      # recommended. semver.
requiredCapabilities: [network]     # must already be active for install to succeed.
grantedCapabilities: [filesystem-write]  # widens the active set on install (ref-counted).
modelsRequired: [eight-1.0-q3:14b, ollama:qwen2.5]  # models the skill needs.
entryPoints: [/deploy, /ship]       # slash commands / triggers that enter the skill.
author: jamesspalding               # recommended for the registry.
license: Apache-2.0                 # recommended. SPDX id.
homepage: https://8gent.dev         # optional.
---
```

### Field reference

| Field | Required | Rule |
| --- | --- | --- |
| `name` | yes | Non-empty. No whitespace, `/`, `\`, or `..` (it becomes a path). Clean kebab-case recommended. |
| `description` | no | Recommended for the registry. |
| `version` | no | If present, must be semver (`1.0.0`, `2.3.1-rc.1`). |
| `requiredCapabilities` | no | Lowercase tokens. Must be active for install to succeed. |
| `grantedCapabilities` | no | Lowercase tokens. Cannot also be required (self-loop). |
| `modelsRequired` | no | Non-empty tokens, no whitespace. `provider:model` allowed. |
| `entryPoints` | no | `/name` or bare `name` tokens. |
| `author` | no | Recommended for the registry. |
| `license` | no | Recommended. SPDX id. |
| `homepage` | no | Source or docs URL. |

Known capabilities (scoped by the harness today): `network`, `filesystem-read`,
`filesystem-write`, `shell`, `browser`, `clipboard`, `audio`, `camera`, `location`,
`secrets`. A well-formed capability outside this set installs with a warning (forward
compatible) rather than an error.

## Validation

`validateManifest(manifest)` (in `packages/skills/manifest.ts`) returns:

```ts
{ ok: boolean; errors: string[]; warnings: string[] }
```

- `errors` block install. `ok` is `errors.length === 0`.
- `warnings` are publishing recommendations (missing version/author/license,
  unknown capability). They never block.

The function is pure and deterministic (no IO), so it runs identically at install,
at registry publish, and in tests.

### Backward compatibility

A skill declaring only `name` + `description` validates `ok: true` with warnings.
No bundled skill needs an edit. This is deliberate: the gate blocks *malformed*
declarations and *unsafe names*, not *incomplete* ones.

## Enforcement: validated at install

`SkillManager.installSkill(name)` calls `validateSkillManifest(skill)` before it
touches the capability set. A manifest with errors returns:

```ts
{ ok: false, skill, missing: [], reason: "invalid skill manifest: <errors>" }
```

and the skill is never installed - no capability is widened, so a malformed
third-party skill cannot smuggle in a grant. A clean manifest proceeds to the
existing capability check (issue #2091) unchanged.

## Not in this slice

- Registry index + `8gent skill install <name>` and signed releases (Step 3).
- Quarantine read-only lane and promotion (Step 4).
- Ten published seed skills as the reference bar (Step 5).

Each of those consumes `validateManifest` as its admission gate.
