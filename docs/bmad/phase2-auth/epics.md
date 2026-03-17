# Phase 2: Auth + User Accounts — Epics & Stories

**Author:** BMAD Architect
**Date:** 2026-03-16
**Status:** Ready for Development

---

## Epic 1: Auth Package Foundation

**Goal:** Create `packages/auth/` with Clerk integration, device code flow, and secure token storage.

### Story 1.1: Create packages/auth with Clerk Client Setup
- Initialize package with `package.json` following `@8gent/secrets` pattern
- Set up Clerk client (`clerk.ts`) with publishable key and secret key from env
- Support both server-side (Bun) and headless CLI usage
- Export `getClerkClient()` singleton

**Acceptance Criteria:**
- `import { getClerkClient } from "@8gent/auth"` works
- Clerk client initializes without React DOM dependency
- Fails gracefully if Clerk keys are not configured

### Story 1.2: Device Code Flow Implementation
- Implement full OAuth 2.0 device authorization grant (RFC 8628)
- `startDeviceFlow()` → returns user code + verification URL
- `pollDeviceFlow()` → polls until approved/denied/expired
- Auto-opens browser on macOS via `open` command
- Handles all error states: slow_down, authorization_pending, expired_token, access_denied

**Acceptance Criteria:**
- `8gent auth login` starts device flow and displays code
- Browser opens automatically on macOS
- Polling respects server-specified interval
- Timeout after 15 minutes with clear error message
- Works in SSH sessions (no browser auto-open, URL displayed)

### Story 1.3: macOS Keychain Token Storage (with Fallback)
- `KeychainTokenStore` class using macOS `security` CLI
- `EncryptedFileTokenStore` class using AES-256-GCM (same pattern as `packages/secrets/`)
- Auto-detect platform and choose appropriate store
- Interface: `store(token)`, `retrieve()`, `clear()`, `exists()`

**Acceptance Criteria:**
- Token stored in macOS Keychain survives terminal restart
- Token retrieved without user interaction (no popup)
- Fallback to encrypted file on Linux/CI
- `8gent auth logout` clears token from both stores
- File permissions are 0o600 on fallback file

### Story 1.4: Auth State Management
- `AuthManager` class with state machine (unknown → anonymous / authenticated / refreshing)
- `login()` — starts device flow, stores token, fetches user
- `logout()` — clears token, resets state
- `getUser()` — returns current user or null
- `isAuthenticated()` — boolean check
- `requireAuth()` — throws if not authenticated (for gated features)
- `getAuthState()` — returns full state with user, plan, token expiry

**Acceptance Criteria:**
- State transitions are atomic and thread-safe
- Token refresh happens transparently before expiration
- Anonymous mode is the default (no forced login)
- All methods are synchronous after initial load (cached state)

### Story 1.5: Auth Types
- `User` — identity from Clerk + GitHub
- `AuthState` — union type: anonymous | authenticated | refreshing | error
- `TokenPayload` — JWT claims structure
- `DeviceFlowState` — polling state machine
- `AuthConfig` — Clerk keys, endpoints, timeouts

**Acceptance Criteria:**
- All types exported from `@8gent/auth`
- No `any` types
- Compatible with Convex user schema

---

## Epic 2: Database Package (Convex)

**Goal:** Create `packages/db/` with Convex schema, server functions, and Bun-compatible client.

### Story 2.1: Initialize Convex Project with Schema
- Create `convex/schema.ts` with tables: users, sessions, usage, preferences
- All tables properly indexed for query performance
- Schema matches architecture document exactly
- Configure Clerk as auth provider in `auth.config.ts`

**Acceptance Criteria:**
- `npx convex dev` accepts the schema without errors
- All indexes defined for primary query patterns
- Auth config points to Clerk issuer domain

### Story 2.2: User CRUD Functions
- `createOrUpdateUser` mutation — upsert on Clerk ID
- `getUserByClerkId` query — lookup by Clerk sub claim
- `updateLastActive` mutation — touch lastActiveAt timestamp
- `deleteUser` mutation — remove user and all related data

**Acceptance Criteria:**
- First login creates user with GitHub profile data
- Subsequent logins update lastActiveAt
- All mutations validate auth identity
- Deletion cascades to sessions, usage, preferences

### Story 2.3: Session Tracking Functions
- `startSession` mutation — create session record with model/provider
- `endSession` mutation — set endedAt, final token counts
- `updateSessionTokens` mutation — increment token counts mid-session
- `getRecentSessions` query — last N sessions for a user
- `getSessionById` query — single session details

**Acceptance Criteria:**
- Sessions link to authenticated user
- Token counts are additive (safe for concurrent updates)
- Incomplete sessions (no endedAt) detectable for crash recovery
- Query returns sessions sorted by startedAt descending

### Story 2.4: Usage Aggregation Functions
- `recordDailyUsage` mutation — create or update daily rollup
- `getDailyUsage` query — single day for a user
- `getUsageRange` query — date range for charts
- `getMonthlySum` query — aggregate for billing

**Acceptance Criteria:**
- Daily rollup is idempotent (re-running doesn't double count)
- Models array has no duplicates
- Date format is YYYY-MM-DD (UTC)
- Monthly sum handles missing days gracefully

### Story 2.5: Preferences Sync Functions
- `getPreferences` query — returns user preferences or defaults
- `setPreferences` mutation — full replace
- `mergePreferences` mutation — partial update (merge incoming with existing)

**Acceptance Criteria:**
- New users get sensible defaults (model: "", provider: "ollama", theme: "default")
- Merge is shallow (top-level keys only)
- updatedAt set on every write
- Returns preferences even if no record exists (defaults)

### Story 2.6: ConvexClient Wrapper for Bun
- `createConvexClient()` — initialize ConvexClient with deployment URL
- `getConvexClient()` — singleton accessor
- Auth token injection via `client.setAuth(tokenFn)`
- Graceful offline handling (queue mutations, skip queries)

**Acceptance Criteria:**
- Works in Bun runtime (not just Node.js)
- Client singleton is lazy-initialized
- Offline mode returns null for queries, queues mutations
- Deployment URL configurable via env var `CONVEX_URL`

---

## Epic 3: CLI Integration

**Goal:** Wire auth into the CLI entry point with `8gent auth *` commands.

### Story 3.1: `8gent auth login` Command
- Starts device code flow
- Displays code and URL
- Auto-opens browser on macOS
- Polls until complete
- Stores JWT in Keychain
- Creates/updates Convex user record
- Displays success with username and plan

**Acceptance Criteria:**
- Full flow completes in < 30s (after user approves)
- Clear error messages for timeout, denied, network error
- Idempotent (running again when logged in shows current user)

### Story 3.2: `8gent auth logout` Command
- Clears JWT from Keychain (and fallback file)
- Resets local auth state
- Does NOT delete Convex user record
- Confirms logout to user

**Acceptance Criteria:**
- Token fully removed (next launch is anonymous)
- No network call needed (logout works offline)
- Confirmation message displayed

### Story 3.3: `8gent auth status` Command
- Shows: username, email, plan, member since
- Shows: current month usage (tokens, sessions, models)
- Shows: token expiry time
- Shows: sync status (what is enabled)

**Acceptance Criteria:**
- Works offline (shows cached data with "offline" indicator)
- Anonymous users see "Not logged in. Run `8gent auth login`"
- Usage data fetched from Convex if online

### Story 3.4: `8gent auth whoami` Command
- Quick one-line identity check: "@username (plan)"
- Or: "anonymous" if not logged in

**Acceptance Criteria:**
- Single line output, no decoration
- Fast (< 100ms, no network call, uses cached state)

### Story 3.5: Auth Check on TUI Startup
- On TUI launch, check for stored token
- If authenticated: show user in status bar, start session tracking
- If anonymous: show "anonymous" in status bar, skip tracking
- Never block startup for auth

**Acceptance Criteria:**
- TUI launches in < 2s regardless of auth state
- Network failure during auth check does not delay startup
- Auth state available to all TUI components via context/prop

---

## Epic 4: TUI Integration

**Goal:** Surface auth state and usage in the TUI interface.

### Story 4.1: Auth Status in TUI Status Bar
- Add user display name or "anonymous" to the status bar
- Show plan badge (Free/Pro/Team) next to name
- Show sync indicator if preferences sync is enabled

**Acceptance Criteria:**
- Status bar shows `@username [Pro]` or `anonymous`
- Follows existing status bar component patterns
- Uses safe colors (no gray/white/black per CLAUDE.md rules)

### Story 4.2: Login Prompt in OnboardingScreen
- Add optional step 9 to onboarding flow
- "Sync across machines? Login with GitHub"
- [Login] starts device flow inline
- [Skip] continues in anonymous mode
- Step is skippable and non-blocking

**Acceptance Criteria:**
- Onboarding completes successfully with or without login
- Login step only shown once (not on re-onboard)
- Device flow feedback shown in TUI (code, waiting, success)

### Story 4.3: Usage Stats in Settings/Profile View
- New `/profile` or `/usage` slash command in TUI
- Shows: current month tokens, sessions, top models
- Shows: preference sync status
- Shows: account tier and limits

**Acceptance Criteria:**
- Available only when authenticated
- Anonymous users see "Login to track usage"
- Data loads async with loading state

### Story 4.4: Sync Preferences on Login
- On login, fetch preferences from Convex
- Merge with local config (local takes precedence for conflicts)
- On preference change, push to Convex (debounced, 5s)
- Sync toggle in config

**Acceptance Criteria:**
- First login on new machine populates local config
- Existing local config not overwritten (merge, not replace)
- Sync failures are silent (log, don't alert)
- Sync can be disabled in config

---

## Epic 5: Session Tracking

**Goal:** Automatically track coding sessions for usage analytics and billing.

### Story 5.1: Auto-Track Session Start/End
- On agent start: create session record with model, provider, timestamp
- On agent exit (clean or crash): set endedAt, final counts
- Handle ungraceful exits via session recovery (check for open sessions on next start)

**Acceptance Criteria:**
- Every authenticated session has a record in Convex
- Crash recovery closes stale sessions on next launch
- Anonymous sessions are not tracked

### Story 5.2: Token Counting Per Session
- Hook into AI SDK usage data (`usage.promptTokens`, `usage.completionTokens`)
- Accumulate per session, update Convex periodically (every 30s or on turn complete)
- Final count set on session end

**Acceptance Criteria:**
- Token counts match AI SDK reported usage
- Batch updates to Convex (not per-token)
- Works with both Ollama and OpenRouter providers

### Story 5.3: Tool Call Counting Per Session
- Increment tool call counter on each tool invocation
- Track per-tool breakdown if available
- Update Convex alongside token counts

**Acceptance Criteria:**
- Total tool calls recorded per session
- Count is accurate (no double-counting retries)

### Story 5.4: Daily Usage Aggregation
- Convex scheduled function runs daily at midnight UTC
- Aggregates all sessions for each user into usage rollup
- Creates/updates usage record for the date

**Acceptance Criteria:**
- No data loss (handles sessions spanning midnight)
- Idempotent (safe to re-run)
- Handles users with zero sessions gracefully

---

## Implementation Order

```
Week 1: Epic 1 (Auth Package) + Epic 2 (DB Package)
         Stories 1.5, 1.1, 1.3, 1.2, 1.4 (types first, then infra, then flow)
         Stories 2.1, 2.2, 2.5, 2.6 (schema, users, prefs, client)

Week 2: Epic 3 (CLI) + Epic 5 (Session Tracking)
         Stories 3.1, 3.2, 3.3, 3.4, 3.5
         Stories 5.1, 5.2, 5.3

Week 3: Epic 4 (TUI) + Epic 5.4 (Aggregation) + QA
         Stories 4.1, 4.2, 4.3, 4.4
         Story 5.4, integration testing, polish
```

## Definition of Done

- [ ] All TypeScript, no `any` types
- [ ] Works in Bun runtime
- [ ] Anonymous mode fully functional (no regressions)
- [ ] Token stored securely (Keychain or encrypted file)
- [ ] Convex schema deployed and tested
- [ ] CLI commands (`login`, `logout`, `status`, `whoami`) working
- [ ] TUI status bar shows auth state
- [ ] Session tracking records to Convex
- [ ] Offline mode degrades gracefully (no crashes)
- [ ] All code follows existing package patterns
