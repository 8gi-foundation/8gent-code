# Phase 2: Auth + User Accounts — Project Brief

**Author:** BMAD Business Analyst
**Date:** 2026-03-16
**Status:** Approved

---

## Why Auth Matters for 8gent

8gent Code is currently a single-user, local-only tool. There is no identity system — just a `.8gent/user.json` file and a machine-fingerprinted secrets vault. This blocks every growth vector:

1. **Multi-user collaboration** — Teams cannot share sessions, prompts, or LoRA weights without identity.
2. **Cloud sync** — Preferences, model configs, and session history are trapped on a single machine. Developers who work across laptop/desktop/CI lose context.
3. **LoRA ownership** — The fine-tuning pipeline (`packages/kernel/`) produces custom model weights. Without auth, there is no way to attribute, protect, or distribute personal LoRAs.
4. **Billing and usage tracking** — Free tier limits, pro upgrades, and team seats all require knowing *who* is using the system.
5. **Marketplace** — Future skill/tool marketplace needs verified identities for publishers.

## User Segments

### Solo Developers (Primary, 80%+ of early users)
- Use 8gent locally with Ollama or OpenRouter.
- Want: cloud preference sync, session history across machines, personal LoRA training.
- Sensitivity: high privacy expectations. Will reject anything that phones home without consent.

### Teams (Secondary, growth target)
- 2-20 developers sharing an 8gent deployment.
- Want: shared model configs, team usage dashboards, invite system, SSO.
- Sensitivity: need audit logs, admin controls, seat management.

### Enterprise (Future, revenue driver)
- 50+ seats, on-prem or managed cloud.
- Want: SAML/OIDC SSO, RBAC, compliance (SOC2), air-gapped mode, central policy.
- Sensitivity: will not adopt without tenant isolation and data residency guarantees.

## Privacy Requirements

8gent's core promise is **local-first, no lock-in**. Auth must not break this:

1. **Anonymous mode is always available.** Auth is opt-in. The TUI must work fully offline with no account.
2. **Opt-in cloud sync.** Users explicitly choose what syncs (preferences, sessions, usage). Code and secrets never leave the machine.
3. **Token storage is local.** Auth tokens live in macOS Keychain (or encrypted file fallback), never in plaintext.
4. **Minimal data collection.** We store: identity (from GitHub OAuth), usage counts, preferences. We do NOT store: code, prompts, file contents, environment variables.
5. **Deletion is real.** Account deletion purges all server-side data within 30 days.

## Revenue Implications

Auth enables the billing pipeline:

| Tier | Price | Requires Auth? | Gated Features |
|------|-------|----------------|----------------|
| Free | $0 | No (anonymous OK) | Local-only, no sync, no LoRA cloud |
| Pro | $19/mo | Yes | Cloud sync, usage analytics, LoRA hosting, priority OpenRouter routing |
| Team | $49/seat/mo | Yes | Shared configs, team dashboard, admin controls, SSO |
| Enterprise | Custom | Yes | SAML, RBAC, audit logs, dedicated support, air-gap option |

Without auth, 8gent cannot:
- Track per-user token consumption (needed for metered billing)
- Gate features by plan tier
- Attribute LoRA weights to owners
- Provide team management UX
- Offer enterprise compliance features

## Success Metrics

| Metric | Target (90 days post-launch) |
|--------|------------------------------|
| Auth adoption rate | 30%+ of active users create an account |
| Login completion rate | 90%+ of users who start device flow finish it |
| Cloud sync opt-in | 50%+ of authenticated users enable at least one sync feature |
| Session tracking coverage | 95%+ of authenticated sessions recorded in Convex |
| Auth flow latency | < 3s from code entry to JWT received |

## Risks

1. **Friction kills adoption.** Device code flow must be frictionless — auto-open browser, clear instructions, fast polling.
2. **Privacy backlash.** Any perception of telemetry without consent will damage trust. Anonymous mode must be prominently available.
3. **Clerk vendor lock-in.** Mitigate by abstracting auth behind `packages/auth/` interface. Clerk is an implementation detail.
4. **Convex cold starts.** First query after inactivity may be slow. Use optimistic local state.
