# Bundled Skills

Skills are reusable, markdown-authored workflows that 8gent can invoke with a slash command or a natural-language trigger. They ship with the CLI so a fresh install has day-one capability.

## Load order

Loaded by `SkillManager.loadSkills()` in `index.ts`. Later sources do not overwrite earlier ones:

1. `~/.8gent/skills/` (flat `.md` files, user overrides everything)
2. Project-level skill overrides under the current working directory (see `index.ts`)
3. `packages/skills/<name>/SKILL.md` (bundled defaults, this directory)
4. `~/.8gent/learned-skills/` (skills promoted by the compounder)

## Bundled skill inventory

| Skill | Trigger | What it does |
|-------|---------|--------------|
| `billiondollarboardroom` | `/billiondollarboardroom` | Summons 8 business legends as advisors for sales, pricing, marketing, and offer decisions. |
| `clone-react` | (invoked) | Recreates a React component or page from a reference, with path rewrites. |
| `design-excellence` | (invoked) | Design-system and token review for UI work. |
| `dogfood-qa` | (invoked) | Systematic QA exploration with priority-tagged repro steps. |
| `motion-design` | (invoked) | Motion, easing, and accessibility rules for transitions and animations. |
| `systematic-debugging` | `/debug` | Reproduce, isolate, hypothesize, verify, fix, confirm. |
| `team-validation` | (invoked) | Validates a multi-agent team composition before kickoff. |
| `test-driven-development` | `/tdd` | Write the failing test first, then the smallest code to pass. |
| `vercel-react` | (invoked) | React best practices patterns. |
| `verification-before-completion` | `/verify` | Run a verification command and read the output before claiming done. |
| `youtube-transcript` | `/youtube-transcript` | Fetch YouTube transcripts without API keys or a browser. |

Total bundled skills on a fresh install: 11 (plus a `commit` example skill auto-created in the user skills directory on first run).

## Format

Every bundled skill lives at `packages/skills/<slug>/SKILL.md` with YAML frontmatter:

```yaml
---
name: my-skill                    # canonical slug
description: One sentence. What it does and when to use it.
trigger: /my-skill                # primary slash command
aliases: [/my, /ms]               # optional extra slash commands
tools: [bash, read, grep]         # optional tool allowlist
examples:                         # optional examples block
  - /my-skill some input
---

# Body

Markdown instructions the agent reads when the skill is invoked.
```

The `name` field is the only required key. `description` is strongly recommended: it is what shows up in discovery.

## Authoring rules for bundled skills

Bundled skills ship to every user on install. Treat that responsibility seriously.

- Generic only. No references to specific contacts, projects, or the maintainer's personal workflow.
- No emojis in code. Reserve emojis for user-facing output when the skill produces it.
- No em dashes. Use hyphens, colons, commas, or parentheses.
- No prompt-injection or jailbreak skills. Ever.
- No AI vendor or model names in examples. Describe the agent behavior instead.
- Keep each skill focused. One clear job. 30 to 120 lines is a healthy range.

See the parent `CONTRIBUTING.md` for the full proposal and review process.
