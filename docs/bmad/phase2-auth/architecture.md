# Phase 2: Auth + User Accounts — Technical Architecture

**Author:** BMAD Architect
**Date:** 2026-03-16
**Status:** Approved

---

## Package Structure

```
packages/auth/                    <-- New package
  package.json
  index.ts                        <-- Public API: login(), logout(), getUser(), requireAuth()
  clerk.ts                        <-- Clerk client setup + JWT template config
  device-flow.ts                  <-- Device code authorization flow for CLI
  token-store.ts                  <-- Secure token storage (macOS Keychain + fallback)
  middleware.ts                   <-- Auth middleware for HTTP endpoints
  types.ts                        <-- User, Session, AuthState, TokenPayload types

packages/db/                      <-- New package (Convex)
  package.json
  convex/
    schema.ts                     <-- Database schema (users, sessions, usage, preferences)
    auth.config.ts                <-- Clerk provider configuration
    users.ts                      <-- User CRUD mutations and queries
    sessions.ts                   <-- Session tracking mutations and queries
    usage.ts                      <-- Usage aggregation (daily rollup, monthly summary)
    preferences.ts                <-- Preference sync (get, set, merge)
  client.ts                       <-- ConvexClient wrapper for Bun server-side usage
  types.ts                        <-- Shared database types
```

## Technology Choices

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Auth Provider | Clerk | Best-in-class DX, built-in device flow, GitHub OAuth, JWT templates |
| Database | Convex | Real-time subscriptions, TypeScript-native, zero-config, serverless |
| Token Storage | macOS Keychain via `security` CLI | OS-level encryption, no extra deps, standard pattern (gh, npm) |
| Fallback Storage | AES-256-GCM encrypted file | For Linux/CI where Keychain unavailable, mirrors `packages/secrets/` pattern |
| OAuth Provider | GitHub | 100% of 8gent users are developers, GitHub is universal |

## Convex Schema

```typescript
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Core user identity - populated from Clerk/GitHub OAuth
  users: defineTable({
    clerkId: v.string(),              // Clerk user ID (sub claim)
    email: v.string(),
    githubUsername: v.string(),
    displayName: v.string(),
    avatar: v.string(),               // GitHub avatar URL
    plan: v.union(
      v.literal("free"),
      v.literal("pro"),
      v.literal("team"),
    ),
    createdAt: v.number(),            // Unix timestamp ms
    lastActiveAt: v.number(),         // Updated on each session start
  })
    .index("by_clerkId", ["clerkId"])
    .index("by_email", ["email"])
    .index("by_githubUsername", ["githubUsername"]),

  // Individual coding sessions
  sessions: defineTable({
    userId: v.id("users"),
    startedAt: v.number(),            // Unix timestamp ms
    endedAt: v.optional(v.number()),  // Set when session ends
    model: v.string(),                // e.g. "qwen3:14b"
    provider: v.string(),             // e.g. "ollama", "openrouter"
    tokensIn: v.number(),             // Input tokens consumed
    tokensOut: v.number(),            // Output tokens generated
    toolCalls: v.number(),            // Total tool invocations
    benchmarkScores: v.optional(
      v.record(v.string(), v.number()),
    ),
  })
    .index("by_userId", ["userId"])
    .index("by_userId_startedAt", ["userId", "startedAt"]),

  // Daily usage rollups
  usage: defineTable({
    userId: v.id("users"),
    date: v.string(),                 // YYYY-MM-DD
    tokensIn: v.number(),
    tokensOut: v.number(),
    sessions: v.number(),
    models: v.array(v.string()),      // Distinct models used that day
  })
    .index("by_userId_date", ["userId", "date"]),

  // User preferences (synced across machines)
  preferences: defineTable({
    userId: v.id("users"),
    defaultModel: v.string(),
    defaultProvider: v.string(),
    theme: v.string(),
    loraStatus: v.union(
      v.literal("none"),
      v.literal("training"),
      v.literal("ready"),
    ),
    loraVersion: v.optional(v.string()),
    customPromptMutations: v.array(v.string()),
    updatedAt: v.number(),
  })
    .index("by_userId", ["userId"]),
});
```

## Device Code Flow — Detailed Sequence

```
Step 1: User runs `8gent auth login`
  |
  v
Step 2: CLI calls Clerk's OAuth device authorization endpoint
        POST https://clerk.8gent.app/v1/oauth/device/authorize
        Body: { client_id, scope: "openid profile email" }
  |
  v
Step 3: Clerk returns:
        {
          device_code: "xyz...",
          user_code: "ABCD-1234",
          verification_uri: "https://8gent.app/auth/device",
          verification_uri_complete: "https://8gent.app/auth/device?code=ABCD-1234",
          expires_in: 900,
          interval: 5
        }
  |
  v
Step 4: CLI displays instructions and auto-opens browser:
        "Opening browser... Visit https://8gent.app/auth/device"
        "Enter code: ABCD-1234"
        exec("open", [verification_uri_complete])  // macOS
  |
  v
Step 5: User authenticates in browser with GitHub OAuth
        Browser -> Clerk -> GitHub -> Clerk -> Success page
  |
  v
Step 6: CLI polls for completion every 5 seconds:
        POST https://clerk.8gent.app/v1/oauth/device/token
        Body: { device_code, client_id, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }
  |
  v
Step 7: On success, Clerk returns JWT. CLI stores in Keychain:
        security add-generic-password -a "8gent" -s "8gent-auth-token" -w "<jwt>"
  |
  v
Step 8: CLI creates/updates user in Convex with Clerk identity
  |
  v
Step 9: CLI displays: "Logged in as @jamesspalding (Pro plan)"
```

## Token Storage Strategy

### Primary: macOS Keychain

```bash
# Store
security add-generic-password -a "8gent" -s "8gent-auth-token" -w "$JWT" -U

# Retrieve
security find-generic-password -a "8gent" -s "8gent-auth-token" -w

# Delete
security delete-generic-password -a "8gent" -s "8gent-auth-token"
```

Benefits: OS-level encryption, survives app updates, standard pattern (used by `gh`, `npm`, `docker`).

### Fallback: Encrypted File

For Linux and CI environments where macOS Keychain is unavailable:

```
~/.8gent/auth-token.enc
```

Uses the same AES-256-GCM + machine-derived key pattern from `packages/secrets/`. The token is encrypted at rest using PBKDF2(hostname:username) as the key.

### Detection Logic

```typescript
function getTokenStore(): TokenStore {
  if (process.platform === "darwin") {
    return new KeychainTokenStore();
  }
  return new EncryptedFileTokenStore();
}
```

## Auth State Machine

```
                     ┌─────────────┐
                     │  UNKNOWN    │  (app starting)
                     └──────┬──────┘
                            │
                     check stored token
                            │
              ┌─────────────┼─────────────┐
              │             │             │
        no token      valid token    expired token
              │             │             │
              v             v             v
       ┌──────────┐  ┌──────────┐  ┌──────────┐
       │ANONYMOUS │  │AUTHED    │  │REFRESHING│
       └──────────┘  └──────────┘  └─────┬────┘
                                         │
                                   ┌─────┼─────┐
                                   │           │
                              refresh OK   refresh fail
                                   │           │
                                   v           v
                            ┌──────────┐ ┌──────────┐
                            │AUTHED    │ │ANONYMOUS │
                            └──────────┘ └──────────┘
```

## Integration Points

### CLI Entry (`bin/8gent.ts`)

New `auth` subcommand:

```typescript
case "auth":
  await authCommand(restArgs);  // login | logout | status | whoami
  break;
```

### Agent Session Start (`packages/eight/agent.ts`)

```typescript
// At session start:
const auth = await getAuthState();
if (auth.state === "authenticated") {
  await trackSessionStart(auth.user.id, model, provider);
}
```

### TUI Status Bar (`apps/tui/src/components/status-bar.tsx`)

New prop:
```typescript
interface EnhancedStatusBarProps {
  // ... existing props
  authUser?: { displayName: string; plan: string } | null;
}
```

### Onboarding Screen

Add optional auth step after current onboarding:
```
Step 9: "Want to sync across machines? Login with GitHub (optional)"
        [Login with GitHub]  [Skip — stay anonymous]
```

## Security Considerations

1. **JWT validation** — Always validate JWT signature against Clerk's JWKS endpoint. Cache JWKS keys for 1 hour.
2. **Token refresh** — Refresh tokens 5 minutes before expiration. If refresh fails, degrade to anonymous (never crash).
3. **No secrets in Convex** — Convex stores identity and usage only. API keys stay in local `packages/secrets/` vault.
4. **HTTPS only** — All Clerk and Convex communication over TLS.
5. **Token scope** — JWT contains minimal claims: sub, email, github_username. No code or file access.
6. **Rate limiting** — Device flow polling respects `interval` from server. Token refresh has exponential backoff.

## Offline Behavior

| Scenario | Behavior |
|----------|----------|
| No internet, no token | Full anonymous mode, all local features work |
| No internet, valid token | Authenticated locally (cached user), session tracking queued |
| No internet, expired token | Falls back to anonymous, queues refresh for when online |
| Internet restored | Flush queued session data to Convex, attempt token refresh |

## Dependencies

### packages/auth

```json
{
  "dependencies": {
    "jose": "^6.0.0"
  }
}
```

Note: Uses `jose` for JWT validation (JWKS fetch, signature verification, claims extraction). No Clerk client SDK needed — the CLI uses Clerk's REST API directly for device flow and `jose` for token verification. Keychain access uses macOS `security` CLI (no npm dep needed). Encrypted file fallback reuses crypto patterns from `packages/secrets/`.

### packages/db

```json
{
  "dependencies": {
    "convex": "^1.17.0"
  }
}
```
