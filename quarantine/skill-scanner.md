# Quarantine: Skill Scanner

## What it does

Scans `~/.claude/skills/` for all `SKILL.md` files and validates them. Outputs an inventory report with validation status.

## Checks performed

1. **Frontmatter presence** - every SKILL.md must have `name` and `description` in YAML frontmatter
2. **Broken file references** - markdown links and `@file` references are checked for existence on disk
3. **Trigger extraction** - pulls "USE WHEN" phrases, workflow table triggers, and slash commands
4. **Missing SKILL.md** - reports skill directories that lack a SKILL.md file entirely

## Usage

```bash
bun run packages/validation/skill-scanner.ts
```

Exit code 0 if all skills valid, 1 if any invalid.

## Programmatic API

```ts
import { scanSkills } from "./packages/validation/skill-scanner";

const result = await scanSkills();
// result.total, result.valid, result.invalid
// result.skills[] - per-skill reports
// result.dirsWithoutSkillMd[] - dirs missing SKILL.md
```

## Graduation criteria

- Confirm scan runs clean on current skill set
- Wire into a pre-session health check or periodic audit
- Consider adding severity levels (warn vs error)
