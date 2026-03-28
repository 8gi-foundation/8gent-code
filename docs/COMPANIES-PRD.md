# 8gentic Economy - PRD

## The 8gentic Economy

8gentic Companies. 8gentic Enterprises. 8gentic Organisations. Teams of 8gents that form, work, deliver, and evolve - run by 8gents, for users, in the 8gent ecosystem.

## Boardroom Decision: 2026-03-26

**Verdict:** GO on concept extraction. Build 8gentic Companies natively.

**Reframe:** Not Paperclip's "zero-human companies" - 8gentic companies are teams of 8gents that users assemble, summon, and orchestrate through Eight. The spec is compatible with Paperclip's format but the runtime is ours.

---

## Problem Statement

8gent can spawn sub-agents via worktrees but has no declarative way to define, share, or import pre-configured teams of specialized 8gents. Users can't say "assemble a security audit crew" or "import the game studio team" and have Eight orchestrate multiple specialists working in parallel.

## What We're NOT Doing

- Not depending on Paperclip's CLI or npm package
- Not joining Clipmart marketplace (premature)
- Not allowing foreign agent prompts to bypass NemoClaw
- Not replacing Lil Eight as the orchestrator - Eight is always pack leader
- Not building an org chart UI - this is a mesh, not a hierarchy

## User Stories

1. **As a developer**, I want to assemble a team of specialized 8gents (frontend, backend, QA) so they can work on different parts of my project in parallel via worktrees.

2. **As a developer**, I want to import a pre-built 8gentic company (e.g., "fullstack-forge") from a GitHub repo so I can get a working team without configuring each agent manually.

3. **As a developer**, I want to share my custom 8gentic company so other 8gent users can import my team configuration.

4. **As a developer**, I want Eight (Lil Eight) to remain my primary agent who delegates to the company members, reports progress, and resolves conflicts.

## Spec Format (Compatible with Paperclip, owned by us)

```
my-company/
  COMPANY.md    # Metadata: name, description, version, goals
  agents/
    frontend/
      AGENT.md  # Role, specialty, tools, system prompt
    backend/
      AGENT.md
    qa/
      AGENT.md
  skills/
    code-review/
      SKILL.md  # Reusable skill definitions
  tasks/
    TASKS.md    # Pre-loaded task templates
```

### COMPANY.md frontmatter

```yaml
---
name: Fullstack Forge
slug: fullstack-forge
version: 1.0.0
schema: 8gentic-company/1.0
authors:
  - name: James Spalding
    github: PodJamz
goals:
  - Ship production-ready fullstack features
  - Maintain test coverage above 80%
  - Follow 8gent Code brand and style guidelines
---
```

### AGENT.md frontmatter

```yaml
---
name: Frontend Specialist
slug: frontend
specialty: React, TypeScript, CSS, accessibility
reports_to: eight  # Always reports to Eight (pack leader)
tools:
  - read_file
  - write_file
  - edit_file
  - run_command
  - web_search
  - desktop_screenshot
policies:
  run_command: require_approval
  write_file: allow
  git_push: deny
---
```

## Technical Approach

### Module: `packages/companies/`

| File | Purpose | Est. Lines |
|------|---------|-----------|
| `types.ts` | Company, Agent, Skill types | ~60 |
| `parser.ts` | Parse COMPANY.md + AGENT.md frontmatter | ~100 |
| `loader.ts` | Load from local dir or GitHub URL | ~80 |
| `spawner.ts` | Hydrate AgentPool + WorktreePool from parsed company | ~120 |
| `index.ts` | Public API + CLI tool definitions | ~80 |

**Total: ~440 lines, 5 files, 0 external dependencies**

### Integration Points

1. `packages/orchestration/agent-pool.ts` - spawn company agents as sub-agents
2. `packages/orchestration/worktree-pool.ts` - assign each agent a worktree
3. `packages/permissions/policy-engine.ts` - per-agent policy scoping (CSO prerequisite)
4. `packages/eight/tools.ts` - new tools: `company_list`, `company_import`, `company_status`
5. `bin/8gent.ts` - CLI command: `8gent company import <source>`

### Security Prerequisites (from CSO brief)

Before any company can be imported, these must land:

1. **Per-agent policy scoping** - Each agent gets its own policy allowlist
2. **Prompt sanitization** - Foreign system prompts scanned before entering agent loop
3. **Network allowlist per agent** - Imported agents get `allowNetwork: false` by default
4. **Immutable core policies** - `addPolicy()` cannot override default blocks at runtime
5. **Isolated memory namespace** - Imported agents get ephemeral memory, not user's store
6. **No external policy loading** - Import never loads YAML policy files from repos

### Implementation Order

1. **Phase A (Security):** Per-agent policy scoping in NemoClaw (~200 lines)
2. **Phase B (Parser):** COMPANY.md + AGENT.md parser with validation (~160 lines)
3. **Phase C (Spawner):** Hydrate agents into pool with worktree assignment (~120 lines)
4. **Phase D (CLI):** `8gent company import/list/status` commands (~100 lines)
5. **Phase E (Tools):** LLM-facing tools for Eight to manage companies (~80 lines)

## Acceptance Criteria

- [ ] `8gent company import ./my-company` parses and spawns agents
- [ ] `8gent company import github.com/user/repo` clones and imports
- [ ] Each imported agent runs in its own worktree with scoped permissions
- [ ] Eight (Lil Eight) orchestrates: delegates tasks, collects results, resolves conflicts
- [ ] Imported agents cannot access user's memory store
- [ ] Imported agents cannot bypass NemoClaw core blocks
- [ ] `8gent company list` shows active companies and agent status
- [ ] `8gent company dismiss` gracefully shuts down all company agents

## Success Metric

- A user can `8gent company import` a pre-built team and have 4 agents working in parallel within 60 seconds
- Zero security incidents from imported agent definitions
- At least 3 community-contributed 8gentic companies within 30 days of launch

## Scope Boundaries

| In Scope | Out of Scope |
|----------|-------------|
| Local + GitHub import | Clipmart marketplace |
| Per-agent policy scoping | Full sandboxing/Docker isolation |
| Worktree-based parallelism | Cross-machine agent mesh |
| Eight as orchestrator | Arbitrary reporting hierarchies |
| Ephemeral agent memory | Persistent imported agent memory |
| CLI commands | TUI company management screen |

## Estimated Effort

- Security prerequisites (Phase A): 1 session
- Parser + loader (Phase B): 1 session
- Spawner + CLI + tools (Phase C-E): 1 session
- Total: 3 focused sessions, ~660 lines of new code
