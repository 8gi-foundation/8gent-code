# Remaining Open Issues - Work Plan

**Last updated:** 2026-03-24

## 8gent-code (10 open)

### Ready to Implement (subagent-friendly)

| # | Issue | Effort | Notes |
|---|-------|--------|-------|
| 23 | Vessel: add browser-use to Dockerfile | Small | Add pip install browser-use to ~/8gent-vessel/Dockerfile |
| 34 | Deck light mode broken | Small | Fix deck-shell.tsx in 8gent-world - CSS forced dark |
| 33 | OG images per deck | Medium | Generate per-deck OpenGraph images for social sharing |
| 10 | Memory: procedural memory | Medium | New file packages/memory/procedural.ts |
| 11 | Memory: lease-based job queue | Medium | New file packages/memory/queue.ts |
| 12 | Vessel: zigpty for PTY/shell | Medium | Research + integrate zigpty package |

### Needs Design/Planning

| # | Issue | Effort | Notes |
|---|-------|--------|-------|
| 24 | Nick on nick.8gentjr.com | Medium | DNS + Vercel subdomain routing + content |
| 26 | Honcho dialectic multi-level reasoning | Large | Architecture decision needed |
| 30 | HyperAgent meta-mutation engine | Large | meta-config.yaml + mutation loop |
| 32 | AutoResearch: Gemini Flash judge | Medium | Wire Gemini as judge in autoresearch harness |

## 8gent-telegram-app (3 open)

| # | Issue | Effort | Notes |
|---|-------|--------|-------|
| 1 | User management + magic links | Large | Needs auth backend decision |
| 2 | Retention/traction analytics | Medium | Needs user table first |
| 3 | Calendar + investor meetings | Medium | CloudStorage or backend |

## Priority Order

1. #23 (Dockerfile fix - unblocks browser tools in vessel)
2. #34 (Light mode CSS fix - quick win)
3. #10 + #11 (Memory enhancements - medium, self-contained)
4. #32 (AutoResearch judge - enables overnight improvement loops)
5. #33 (OG images - marketing value)
6. Rest as capacity allows
