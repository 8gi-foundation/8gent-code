# 8gent Code - Agent Context

**Repo:** 8gi-foundation/8gent-code
**Domain:** 8gent.dev
**Runtime:** Bun (not Node)
**Stack:** Bun, Ink v6 (React for CLI), SQLite + FTS5, TypeScript

## Repo-Specific Rules

- Bun everywhere. Never use Node or npm in scripts.
- Run `bun run tui` to test before any push. Never push untested.
- Run `bun run benchmark:v2` for capability regression.
- TUI uses Ink v6 - React component model but for terminal.
- Provider model is ADAPTIVE ROUTER, not a single provider. Do not describe as "Ollama default".
- 11 providers wired. See `packages/providers/` for registry.
- NemoClaw policy engine is deny-by-default (`packages/permissions/policy-engine.ts`).
- Never add `Co-Authored-By` to commits. Never reference AI vendors in code or commits.

## Key Files

| File | Purpose |
|------|---------|
| `packages/eight/tools.ts` | Core tool definitions |
| `packages/eight/agent.ts` | Agent loop, abort, checkpoint restore |
| `packages/eight/prompts/system-prompt.ts` | System prompt |
| `packages/permissions/policy-engine.ts` | NemoClaw deny-by-default |
| `packages/memory/store.ts` | SQLite + FTS5 memory |
| `packages/providers/failover.ts` | Failover chain |
| `apps/tui/` | Terminal UI entry point |

## Provider Failover Chain

local 8gent (localhost) -> local Qwen (localhost) -> OpenRouter `:free`

`auto:free` = dynamically picks best OpenRouter `:free` model.
Apple Foundation auto-enables on macOS 26 + Apple Silicon + bridge binary.

---

# 8GI Ecosystem Context

> Canonical source of truth. Auto-propagated to all 8GI repos on every push to `8gi-governance` main.
> Last updated by: CI auto-sync. Edit here, not in individual repos.

---

## Mission

Democratize infinite general intelligence for everyone. Free, local-first, privacy-preserving.

## The 8 Principles

1. Design first, not last. Friction is the enemy.
2. Free and local by default. No API keys to start. Cloud is opt-in.
3. Self-evolving. Skills accumulate. Lessons persist.
4. Hyper-personal. Learn the user's patterns, preferences, codebase, style.
5. Accessible. Voice input, screen readers, audio docs. Adapt to the user.
6. Orchestrate by default. Delegate to sub-agents. Decompose complexity.
7. Reduce friction, increase truth. Prefer voice and conversation over forms.
8. The work speaks for itself. Ship, don't sell. Evidence, not enthusiasm.

---

## Product Ecosystem

| Product | Domain | Repo | Stack | Status |
|---------|--------|------|-------|--------|
| **8gent OS** | 8gentos.com / {user}.8gentos.com | 8gent-OS | Next.js 16, Convex, Clerk, Stripe | Active - Wave 4 |
| **8gent Code** | 8gent.dev | 8gent-code | Bun, Ink v6 (React TUI) | Shipped v0.13.0 |
| **8gent Jr** | 8gentjr.com | 8gentjr | Next.js, Convex, Clerk | Active - COPPA compliant |
| **8gent World** | 8gent.world | 8gent-world | Astro/Next.js | Docs + ecosystem story |
| **8GI Foundation** | 8gi.org | 8gi-governance | Next.js, Convex, Clerk | Auth-gated inner circle |
| **8gent App** | 8gent.app | 8gent | TBD | Concept stage |

---

## Architecture Decisions (binding across all repos)

### Infrastructure
- **Primary cloud**: Vercel (Next.js hosting) + Hetzner cax21 (self-hosted daemon/vessels)
- **Database**: Convex (multi-tenant via `tenantId` field on every table)
- **Auth**: Clerk (prod + dev)
- **Billing**: Stripe
- **Storage**: Hetzner Object Storage
- **Vessel runtime**: Fly.io Amsterdam (eight-vessel.fly.dev) - parallel to Hetzner, not replaced yet

### 8gent OS Tenant Model
- Each user gets `{username}.8gentos.com`
- Wildcard Vercel domain routes to Next.js `[username]` dynamic route
- Convex row-level multi-tenancy via `tenantId`
- Per-user: mini-apps, marketplace installs, skills, memory, voice

### Provider Stack (8gent Code)
- Adaptive router, NOT a single provider
- Default active: `8gent` (localhost) + `ollama`
- 11 providers wired: `8gent`, `ollama`, `openrouter`, `groq`, `grok`, `openai`, `anthropic`, `mistral`, `together`, `fireworks`, `replicate`
- Failover: local 8gent -> local Qwen -> OpenRouter `:free`
- Apple Foundation: auto-enables on macOS 26 + Apple Silicon

---

## Hard Rules (NON-NEGOTIABLE - all repos, all agents)

### Code
- No em dashes anywhere. Use hyphens or rewrite.
- No purple/pink/violet (hues 270-350) in any UI.
- No secrets in chat or commits. File-based injection only.
- No AI vendor names in any surface (no Claude, Anthropic, OpenAI, Hermes, Nous).
- No Co-Authored-By in git commits. James owns 100% of all work.
- No direct push to main. Always feature branch + PR.
- Post-push Vercel check mandatory: HTTP 200 + screenshot + Telegram. This is the definition of done.
- Bun, not Node, for all 8GI runtimes.
- Test before pushing. Never push untested code.

### Content / Copy
- No customer-facing AI/tooling language. No "Export for AI", "Send to Claude", etc.
- No em dashes in any publication.
- No invented biography or statistics about the founder.
- No personal details about the founder's family in any public content (names, ages, health, school, etc.).
- No formal diagnosis claims about the founder.
- aidhd.dev is stealth mode - do not mention publicly.

### Process
- Every change gets a GitHub issue first. Link PR to issue with `Closes #N`.
- All work tracked at: https://github.com/orgs/8gi-foundation/projects/1
- Multi-step setups: finish every step in order, do not jump ahead.
- Input needed from James: send as Telegram KittenTTS voice note (KittenTTS only, NO ElevenLabs ever).
- Blog posts ship with KittenTTS voiceover embedded.

---

## Sign-Off Protocol (mandatory on every shipping turn)

```
SIGN-OFF:
  VOICE:    say -v {Officer} "{summary}"
  VALIDATE: {production URL}
  VISUAL:   {screenshot result or "Deploy pending"}
  COMMIT:   {message} - {hash} on {branch}
  PUSHED:   {org}/{repo} {branch}
  ISSUE:    {GH issue URL} ({open|closed}) or "No linked issue"
  PR:       {PR URL} or "Direct push to {branch}"
```

---

## The 8GI Board

| Code | Officer | Role |
|------|---------|------|
| 8EO | AI James | Executive Officer - strategic alignment |
| 8TO | Rishi | Technology Officer - architecture, feasibility |
| 8PO | Samantha | Product Officer - user value, UX |
| 8DO | Moira | Design Officer - experience quality, brand |
| 8SO | Karen | Security Officer - risk, compliance, COPPA/GDPR |
| 8CO | Luis | Community Officer - ecosystem, adoption |
| 8MO | Zara | Marketing Officer - narrative, positioning |
| 8GO | Solomon | Governance Officer - policy, constitution |

Boardroom minutes: `8gi-governance/docs/boardroom-minutes/`
Public render: 8gi.org/minutes (auth-gated)

---

## GitHub Workflow

1. Check for existing issues before starting: `gh issue list --repo 8gi-foundation/{repo}`
2. Every PR references the issue it closes: `Closes #N` in PR body.
3. Move project items: Todo -> In Progress when starting, -> Done when merged.
4. Branch naming: `feat/`, `fix/`, `docs/`. Never push directly to main.
5. PR process: branch -> commit -> push -> open PR -> merge via `gh pr merge --admin`.
6. Close issues with evidence: commit hash + PR number + validation URL.
7. Project board: https://github.com/orgs/8gi-foundation/projects/1

---

## Agent Mail

Async messaging across sessions and agents.
- Store: `~/.claude/agent-mail.db`
- CLI: `~/.claude/bin/agent-mail`
- Check inbox: `~/.claude/bin/agent-mail inbox --as AIJames`
- Send: `~/.claude/bin/agent-mail send --from AIJames --to {Name} --subject "..." --body "..."`
- Recipients: officer first names (Rishi, Samantha, Moira, Karen, Luis, Zara, Solomon) or codes (8TO, etc)

---

## Key Contacts

Personal contact details (email, Telegram, Discord handles) are NOT stored in this public file.
They live in `8gi-governance/context/contacts.md` (private repo) and are loaded into agent
context at runtime via the CI sync workflow. Do not paste personal handles, emails, or phone
numbers into this file or any other file in a public repo.

---

## Context Sync

This file is the source of truth. The CI sync workflow (`8gi-governance/.github/workflows/sync-context.yml`) propagates it to all repos on every push to `8gi-governance` main.

Per-product roadmaps: `8gi-governance/context/roadmaps/{product}.md` (maintained by Rishi / 8TO)
Current status: auto-generated by CI from GitHub API on every push to any 8GI repo main.

---

# 8GI Ecosystem Status

> Auto-generated by CI on every push to main in any 8GI repo.
> Do not edit manually - changes will be overwritten.
> Last generated: see git log.

---

## 8gent OS (8gentos.com)

**Parity vs AI James OS prototype:** ~37% (as of 2026-04-30, after PR #141 merge)

### Shipped (Wave 4, 2026-04-30)
- 55-theme system + token inheritance from AI James OS (`feat/themes-port` #157)
- Mini-apps: per-user Convex table, dynamic `[username]/m/[slug]` route, build/fail states
- Marketplace: listings, installs, review queue, approve/reject, storefront, home-screen install
- iOS-style tap-to-zoom app open animation
- All "Coming Soon" stubs replaced with polished pages (16 routes: chat, memory, projects, browser, canvas, research, sessions, music, calendar, messages, design, photos, infinite, debug, channels, updates)
- SubscriptionControl skill UI (Advisor/Copilot/Autopilot levels)
- Settings page: tabbed layout (general/models/voice/adhd/permissions/system-files/billing)
- Skills page: search, category filter, toggle grid

### Remaining gaps vs prototype
- Lock screen / per-tenant onboarding flow
- Design token enforcement (eslint + visual regression CI)
- Phase 0.5 security gates before provisioning friends (Darragh/Jacob/Charles/Kristen)

---

## 8gent Code (8gent.dev)

**Version:** 0.13.0 (shipped 2026-04-30)

### Shipped in v0.13.0
- TUI bottom-bar redesign (DjDeck, AgentInstrumentStrip, ModeFooter, HeaderBar, BottomBar)
- Capability tiers, sqlite-vec, app archive format, tmux backend
- Hotkey changes: Ctrl+Y cycles modes, Ctrl+T unambiguous new-tab
- SubscriptionControl skill ported from 8gent-OS

### In progress
- 8gent Computer voice-first design (31 issues #1847-#1877)
- apfel (Apple Foundation local server) wired at #1848
- Wake word engine: livekit-wakeword (Apache 2.0, native Swift)
- Headless CLI parity non-negotiable

---

## 8gent Jr (8gentjr.com)

### Shipped (2026-04-30)
- VPC step 2: 24h delay default for COPPA email-plus verification (#162)
- CI lint blocking emotion/affect detection imports as EU AI Act guard (#163)

### Compliant with
- COPPA (children under 13)
- EU AI Act emotion/affect detection prohibition

---

## 8gent World (8gent.world)

- Documentation and ecosystem story site
- v0.13.0 release section: PR #477 BLOCKED/MERGEABLE

---

## 8GI Foundation (8gi.org)

- Auth-gated inner circle site
- Agent-mail inbox live at /internal/inbox
- Boardroom minutes rendered at /minutes
- Submissions: internal-only (policy/legislature)

---

## Infrastructure

| Component | State |
|-----------|-------|
| Vercel | All repos deployed, green |
| Hetzner cax21 (nbg1) | IP [REDACTED-IP] - greenfield, SSH key setup needed |
| Fly.io (eight-vessel.fly.dev) | Running, parallel to Hetzner |
| Convex | Multi-tenant, 22 tables, row-level via tenantId |
| Clerk | Auth on prod + dev |
| Stripe | Billing configured |

---

## Open Issues Snapshot

*Updated by CI - see GitHub for live state*

- 8gent-OS: 0 open PRs
- 8gent-code: active development (8gent-computer epic #1847)
- 8gentjr: #165 kids-mode policy (in-flight)
- 8gi-governance: active

---

## Entity Structure

- **Decided (2026-04-20 boardroom, 8-0):** Hybrid CLG+Charity parent + 8gent LTD subsidiary
- **Immediate action:** LTD incorporation first, IP assigned day 1
- **Trip ODell NDA:** re-executes on LTD once formed

---

# 8gent Code Roadmap

> Maintained by Rishi (8TO).

---

## Shipped (v0.13.0, 2026-04-30)

- TUI bottom-bar redesign (DjDeck, AgentInstrumentStrip, ModeFooter, HeaderBar, BottomBar)
- Capability tiers, sqlite-vec, app archive format, tmux backend
- Hotkey: Ctrl+Y cycles modes, Ctrl+T new-tab
- SubscriptionControl skill
- apfel (Apple Foundation local server) wired

---

## In Progress

- 8gent Computer: full computer-use agent runtime, voice I/O (epic #1847, 31 sub-issues)
- Wake word engine: livekit-wakeword (Apache 2.0, native Swift, ANE/CoreML)
- Headless CLI parity

---

## Next

- Wake phrase selection (James to pick "Hey 8" vs "Hey 8gent")
- Electron/Tauri desktop shell (post Phase 6, after openwork FSL ruling out)
- Cerebras / Chutes / Cohere provider wiring

---

## Deferred

- RL fine-tuning pipeline (packages/kernel/ - off by default)
- Picovoice wake engine (NO native macOS Swift binding, rejected 2026-04-25)
- openwork fork (FSL-1.1-MIT Competing Use clause blocks commercial derivative)

---

*Rishi: add effort estimates.*
