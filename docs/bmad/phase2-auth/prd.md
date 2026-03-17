# Phase 2: Auth + User Accounts — Product Requirements Document

**Author:** BMAD Product Manager
**Date:** 2026-03-16
**Version:** 1.0

---

## Overview

Add authentication, user accounts, and cloud persistence to 8gent Code using Clerk (auth provider) and Convex (real-time database). The system must preserve 8gent's local-first philosophy while enabling optional cloud features.

---

## User Stories

### P0 — Must Have (Launch Blocker)

**US-001: CLI Login via Device Code Flow**
> As a developer, I want to log into 8gent from my terminal without leaving the CLI, so that I can authenticate quickly on headless machines or SSH sessions.

Acceptance Criteria:
- Running `8gent auth login` starts the device code flow
- CLI displays a URL and a short code (e.g., ABCD-1234)
- Browser opens automatically on macOS
- CLI polls and completes login within 30s of user approving
- JWT is stored securely in macOS Keychain
- Works over SSH (displays URL for manual copy)

**US-002: User Profile Storage**
> As an authenticated user, I want my profile (name, email, GitHub username, avatar) stored server-side, so that my identity persists across machines.

Acceptance Criteria:
- First login creates a user record in Convex
- Profile populated from GitHub OAuth (name, email, username, avatar)
- Profile accessible via `getUser()` API
- Profile viewable via `8gent auth whoami`

**US-003: Session Token Management**
> As a returning user, I want 8gent to remember my login, so that I don't have to authenticate every time I open a terminal.

Acceptance Criteria:
- Token persists across terminal sessions (Keychain storage)
- Token automatically refreshes if near expiration
- Expired tokens trigger re-auth prompt (not crash)
- `8gent auth logout` clears all stored tokens

**US-004: Anonymous Mode**
> As a privacy-conscious user, I want to use 8gent without any account, so that I retain full local functionality.

Acceptance Criteria:
- 8gent works fully without login (current behavior preserved)
- No network calls made in anonymous mode
- Auth prompts are skippable with clear "skip" option
- Status bar shows "anonymous" instead of user info

### P1 — Should Have (Fast Follow)

**US-005: GitHub OAuth as Primary Login**
> As a developer, I want to log in with my GitHub account, so that I don't need to create a separate password.

Acceptance Criteria:
- GitHub is the primary (and initially only) OAuth provider
- GitHub username and avatar populate the user profile
- Repository access permissions are requested (for future features)

**US-006: Usage Stats Tracking**
> As a user, I want to see my usage statistics (tokens consumed, sessions, models used), so that I can understand my consumption patterns.

Acceptance Criteria:
- Each session records: model, provider, tokens in/out, tool calls, duration
- Daily aggregation available via `8gent auth status`
- Data synced to Convex for cross-machine view
- Usage data never includes code content or prompts

**US-007: Model Preference Sync**
> As a user with multiple machines, I want my model preferences synced, so that 8gent behaves consistently everywhere.

Acceptance Criteria:
- Default model, provider, theme sync to Convex on change
- New machine pulls preferences on first authenticated session
- Local overrides take precedence (config.json > cloud)
- Sync is opt-in (explicit toggle)

### P2 — Nice to Have (Future)

**US-008: Team Accounts**
> As a team lead, I want to create a team and invite members, so that we can share configurations and track team usage.

**US-009: Email Updates**
> As a user, I want optional email summaries of my weekly usage, so that I stay informed without checking the CLI.

**US-010: Personal LoRA Ownership**
> As a user who fine-tuned a personal LoRA, I want it linked to my account, so that I can use it across machines and control who else can access it.

---

## Auth Flow Diagrams

### Device Code Flow (P0)

```
User                    CLI (8gent)              Clerk API              Browser
 |                         |                        |                      |
 |  8gent auth login       |                        |                      |
 |------------------------>|                        |                      |
 |                         |  POST /device/code     |                      |
 |                         |----------------------->|                      |
 |                         |  { device_code,        |                      |
 |                         |    user_code,          |                      |
 |                         |    verification_uri }  |                      |
 |                         |<-----------------------|                      |
 |                         |                        |                      |
 |  "Visit URL, enter      |                        |                      |
 |   code: ABCD-1234"     |                        |                      |
 |<------------------------|                        |                      |
 |                         |  open(verification_uri)|                      |
 |                         |-------------------------------------->|       |
 |                         |                        |              |       |
 |                         |  poll POST /device/token              |       |
 |                         |----------------------->|              |       |
 |                         |  { "pending" }         |              |       |
 |                         |<-----------------------|              |       |
 |                                                                 |       |
 |  [User enters code in browser, approves GitHub OAuth]           |       |
 |                                                  |<-------------|       |
 |                         |  poll POST /device/token|             |       |
 |                         |----------------------->|              |       |
 |                         |  { access_token, jwt } |              |       |
 |                         |<-----------------------|              |       |
 |                         |                        |              |       |
 |                         |  store JWT in Keychain |              |       |
 |                         |  create/update Convex  |              |       |
 |                         |  user record           |              |       |
 |                         |                        |              |       |
 |  "Logged in as @user"   |                        |              |       |
 |<------------------------|                        |              |       |
```

### Token Lifecycle

```
                    +------------------+
                    |  No Token        |
                    |  (Anonymous)     |
                    +--------+---------+
                             |
                    8gent auth login
                             |
                    +--------v---------+
                    |  Device Flow     |
                    |  (Polling...)    |
                    +--------+---------+
                             |
                    User approves in browser
                             |
                    +--------v---------+
                    |  Token Stored    |
                    |  (Keychain)      |
                    +--------+---------+
                             |
              +--------------+---------------+
              |                              |
     Token valid                    Token expired
              |                              |
     +--------v---------+          +--------v---------+
     |  Authenticated   |          |  Auto-Refresh    |
     |  Session Active  |          |  (Background)    |
     +--------+---------+          +--------+---------+
              |                              |
              |                    Refresh succeeds? ----No----> Prompt re-login
              |                              |
              |                    Yes       |
              |                              |
              +<-----------------------------+
              |
     8gent auth logout
              |
     +--------v---------+
     |  Token Cleared   |
     |  (Back to Anon)  |
     +------------------+
```

### Startup Auth Check

```
8gent launches
      |
      v
Check Keychain for token
      |
      +--- No token ---> Anonymous mode (full local features)
      |
      v
Validate token with Clerk
      |
      +--- Invalid/expired ---> Attempt refresh
      |                              |
      |                    +---------+---------+
      |                    |                   |
      |              Refresh OK         Refresh fails
      |                    |                   |
      |                    v                   v
      |              Continue          Warn user, fall back
      |              authenticated     to anonymous mode
      |                    |
      v                    |
Fetch user from Convex <---+
      |
      v
Update lastActiveAt
      |
      v
Session starts (tracked)
```

---

## Non-Functional Requirements

| Requirement | Target |
|-------------|--------|
| Auth flow completion time | < 30s end-to-end |
| Token validation latency | < 500ms |
| Offline degradation | Full local functionality, no crashes |
| Token security | macOS Keychain (primary), AES-256 encrypted file (fallback) |
| Data stored server-side | Identity, usage counts, preferences only |
| Data NEVER stored server-side | Code, prompts, file contents, env vars, secrets |

---

## Out of Scope (Phase 2)

- SAML/OIDC SSO (Enterprise, Phase 5)
- RBAC / role-based permissions (Enterprise, Phase 5)
- Billing integration (Stripe, Phase 3)
- Multi-tenant data isolation (Phase 5)
- LoRA marketplace (Phase 4+)
- Email/password authentication (GitHub OAuth only for now)
