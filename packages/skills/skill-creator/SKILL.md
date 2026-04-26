---
name: skill-creator
description: Author a new bundled skill from a task description, success criteria, and example input/output pairs. Drafts the SKILL.md, runs deterministic validation, and persists to ~/.8gent/skills only after explicit approval. Use when the user says "create a skill", "teach yourself", "learn how to", or asks to bottle a workflow you just executed.
trigger: /create-skill
aliases: [/teach-yourself, /learn-how-to, /skill-create]
tools: [read, write, edit]
---

# Skill Creator

Skills are 8gent's long-term memory of "how I work." When a workflow has worked twice, write it down so the next session inherits it. This skill is the meta-skill that does the writing.

## When to use

- The user said "create a skill", "teach yourself", "learn how to", or "bottle this workflow".
- A workflow you just ran would help future sessions and is concrete enough to describe in 3-7 steps.
- The workflow has a measurable success criterion you can state in plain English.

Do not use this skill for one-off tasks, exploratory questions, or anything that depends on session-specific state (open files, current branch, transient errors).

## Contract (v1, board-approved)

Persistence is consent-first. The creator never writes to disk without `approved: true`. The default surface is `createSkillDraft()`, which returns a preview the user reviews before approval.

```
createSkillDraft(input) -> { slug, fileName, filePath, markdown, validation }
createSkill(input)      -> persists only when input.approved === true
```

Validation is deterministic and local. No A/B claims, no shell-experiment generation, no autonomous mutation. Every persisted skill is a flat file at `~/.8gent/skills/<slug>.md` so `SkillManager.loadSkills()` picks it up on the next reload.

## Workflow

1. Confirm the workflow is worth bottling. Ask the user: name, one-line description, 1-3 examples (input then output), 2-5 success criteria. Do not invent these.
2. Pick a slug. Lowercase, hyphenated, under 60 characters, derived from the name.
3. Pick the tool allowlist. Default to read-only (`read`, `grep`). Only widen to `bash`, `edit`, `write`, `git_*`, or `web` when the workflow demands it. Tools outside the allowlist are rejected.
4. Build the input and call `createSkillDraft()`. Read the returned validation block.
5. If validation fails, fix the inputs (longer description, missing example, banned content, oversized body) and redraft. Do not bypass the validator.
6. Show the user the rendered markdown and the validation summary. Ask explicitly: "approve and persist to `~/.8gent/skills/<slug>.md`?"
7. Only after approval, call `createSkill({ ...input, approved: true })`.
8. Reload the skill manager so the new trigger is live: `await getSkillManager().reloadSkills()`. The result of `createSkill` carries `requiresReload: true` as a reminder.
9. Confirm to the user with the absolute path and the slash trigger that now resolves.

## Inputs

```ts
interface CreateSkillInput {
  taskDescription: string;       // >= 12 chars, plain English
  successCriteria: string[];     // >= 1, each a single bullet
  examples: Array<{
    input: string;
    output: string;
  }>;                            // >= 1, concrete I/O pairs
  name?: string;                 // defaults to slug from taskDescription
  trigger?: string;              // defaults to /<slug>
  aliases?: string[];            // optional alternate slash commands
  tools?: string[];              // defaults to ["read", "grep"]
  skillsRoot?: string;           // defaults to ~/.8gent/skills
  approved?: boolean;            // REQUIRED true for createSkill to persist
  allowOverwrite?: boolean;      // false by default; existing slug is rejected
}
```

## Validation gates (any failure blocks persistence)

- `taskDescription` is at least 12 characters.
- At least one `successCriteria` and one `examples` entry.
- Slug is non-empty and at most 60 characters.
- Primary trigger is a non-empty slash command.
- Every requested tool is on the allowlist (`read`, `grep`, `bash`, `git_status`, `git_diff`, `git_add`, `git_commit`, `web`, `edit`, `write`).
- No banned patterns in the combined task / criteria / examples text: instruction override, secret extraction, exfiltration, jailbreak, policy bypass, or secret material.
- Frontmatter contains `name`, `description`, `trigger`, and the `self-authored: true` marker.
- Body length warning under 20 lines or over 160 lines (warning, not a block).
- File at `~/.8gent/skills/<slug>.md` does not already exist unless `allowOverwrite === true`.

## Drafting rules

- Imperative, second-person voice. "Run X. Check Y." Not "the user should run X."
- One workflow per skill. If two workflows share inputs, they are still two skills.
- Examples are concrete. No `<placeholder>` or `[TODO]`. If you cannot write a real example, you do not yet understand the workflow.
- Success criteria are observable. "Reduces retries" is observable. "Feels cleaner" is not.
- Never include credentials, API keys, hostnames, or any user-specific secret in the skill body. The validator scans for these and rejects.
- No em dashes anywhere in the rendered skill (8gent house style). Use hyphens or rewrite.

## Anti-patterns

- Drafting and persisting in one turn without showing the user the markdown. Approval must be explicit.
- Re-running on a slug that already exists with `allowOverwrite: true` to silently replace a skill. Open a new slug or delete the old file first.
- Adding `bash`, `edit`, or `write` to the tool list "in case." Start read-only and widen only when a real step needs it.
- Authoring a skill from a workflow you have not actually completed in this session. The creator is for codifying lived experience, not speculating.
- Claiming an A/B improvement. v1 has no baseline runner. The validator is a sanity gate, not a quality measurement.

## After persistence

The new skill triggers on `/<slug>` and any `aliases` immediately after `reloadSkills()`. It also surfaces through `findByTrigger()` on any of its `triggers` (currently the slash form). It does not appear in `listLearnedSkills()` because user-authored skills are loaded by `SkillManager` directly from `~/.8gent/skills`, not via the learned-skill path.

If a created skill turns out to be wrong or unhelpful, delete the file and reload. There is no separate revoke API in v1.
