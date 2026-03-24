# Remaining Open Issues - Work Plan

**Last updated:** 2026-03-24

## Summary

- **8gent-code:** 6 open issues
- **8gent-telegram-app:** 3 open issues
- **Closed this session:** 20 issues

## 8gent-code (6 open)

### Ready to Implement

| # | Issue | Effort | Notes |
|---|-------|--------|-------|
| 12 | Vessel: zigpty for PTY/shell | Medium | Research + integrate zigpty package |
| 32 | AutoResearch: Gemini Flash judge | Medium | Wire Gemini as judge in autoresearch harness |
| 33 | OG images per deck | Medium | Generate per-deck OpenGraph images for social sharing |

### Needs Design/Planning

| # | Issue | Effort | Notes |
|---|-------|--------|-------|
| 24 | Nick on nick.8gentjr.com | Medium | DNS + Vercel subdomain routing + content |
| 26 | Honcho dialectic multi-level reasoning | Large | Architecture decision needed |
| 30 | HyperAgent meta-mutation engine | Large | meta-config.yaml + mutation loop |

## 8gent-telegram-app (3 open)

| # | Issue | Effort | Notes |
|---|-------|--------|-------|
| 1 | User management + magic links | Large | Needs auth backend decision |
| 2 | Retention/traction analytics | Medium | Needs user table first |
| 3 | Calendar + investor meetings | Medium | CloudStorage or backend |

## Closed This Session (20 issues)

| # | Issue | Resolution |
|---|-------|------------|
| 7 | Memory: contradiction detection | Shipped in packages/memory/ |
| 8 | Memory: health introspection | Shipped in packages/memory/ |
| 9 | Memory: checkpointing | Shipped in packages/memory/ |
| 10 | Memory: procedural memory | Shipped in packages/memory/procedural.ts |
| 11 | Memory: lease-based job queue | Shipped in packages/memory/queue.ts |
| 13 | Daemon: always-on agent process | Shipped as @8gent/daemon package |
| 14 | Daemon: AgentPool wiring | Wired daemon to real agent loop via AgentPool |
| 15 | Proactive: content packaging rules | Shipped rules engine in proactive package |
| 16 | Proactive: business agent system | Shipped business agent in proactive package |
| 17 | Model router: free model shootout | Completed - Step 3.5 Flash won at 15s |
| 18 | Vessel: model selection upgrade | Switched to stepfun/step-3.5-flash:free |
| 19 | Telegram Mini App: initial build | Shipped 10 screens at 8gent-telegram-app.vercel.app |
| 20 | Telegram Mini App: iOS home screen | Working as installable PWA |
| 21 | Delegation: maxTurns increase | Bumped from 15 to 25 maxTurns |
| 22 | Permissions: headless expansion | Auto-approved write, git push non-main, gh CLI |
| 23 | Vessel: add browser-use to Dockerfile | Shipped - pip install browser-use in Dockerfile |
| 25 | Monorepo: package audit | Inventoried and confirmed 42 packages |
| 27 | Memory v1 enhancements rollup | All 5 memory sub-issues (#7-#11) shipped |
| 28 | Vessel context: spec refresh | Updated VESSEL-CONTEXT.md to March 2026 |
| 34 | Deck light mode broken | Fixed deck-shell.tsx CSS in 8gent-world |

## Priority Order

1. #32 (AutoResearch judge - enables overnight improvement loops)
2. #12 (zigpty PTY - unblocks real shell in vessel)
3. #33 (OG images - marketing value)
4. #24 (Nick subdomain - personal project)
5. #26, #30 (Large architecture work - as capacity allows)
