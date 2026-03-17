# Phase 3: CLUI Integration -- Architecture

## Component Hierarchy

```
<App>
  <AuthGate>                    -- Non-blocking auth check
    <TitleBar>                  -- Shows auth status (avatar or "Anonymous")
    <TabBar>
    <SessionPanel>
      <MessageList />
      <ThinkingView />          -- Shown during processing
      <EvidencePanel />         -- Collapsible right sidebar
      <PlanKanban />            -- Toggle with Cmd+K
      <CommandInputBar />
    </SessionPanel>
    <StatusBar />
    <SettingsPanel />           -- Overlay, toggle with Cmd+,
  </AuthGate>
</App>
```

## State Management

### Zustand Stores

```
session-store.ts     -- Existing: multi-tab sessions, messages, tool calls
auth-store.ts        -- NEW: wraps AuthManager, user, isAuthenticated, login/logout
preferences-store.ts -- NEW: theme, model, hotkeys; local-first with cloud sync
```

### Auth Flow Through CLUI

```
App mount
  -> auth-store.initialize()
    -> AuthManager.initialize()
      -> KeychainTokenStore.retrieve()
        -> Token found? -> validate -> authenticated state
        -> No token? -> anonymous state
  -> auth-store subscribes to AuthManager.onStateChange
  -> If authenticated -> Convex client gets token provider
  -> useConvexSync hook starts tracking sessions

Login flow:
  AuthGate "Sign in" button
    -> auth-store.login()
      -> AuthManager.login()
        -> executeDeviceFlow()
          -> onDeviceCode callback -> show code in AuthGate UI
          -> Browser opens verification URL
          -> Polling for completion
        -> On success -> store token, extract user
    -> auth-store updates -> React re-renders
    -> useConvexSync detects auth -> sets Convex token provider
    -> Preferences sync from cloud
```

### Convex Real-Time Sync

```
useConvexSync hook:
  - Watches auth-store for authentication changes
  - On authenticated:
    - Sets ConvexClient token provider (AuthManager.getAccessToken)
    - Syncs preferences (local -> cloud merge, local wins)
    - Starts session tracking (mutations on session start/end)
    - Subscribes to usage stats (query)
  - On anonymous:
    - Clears Convex auth
    - Stops session tracking
    - All data stays local only
  - Offline handling:
    - ConvexClientWrapper queues mutations
    - Flush on reconnect
    - Never blocks UI
```

## Data Flow

```
                    +------------------+
                    |   tokens.css     |
                    |  (CSS variables) |
                    +--------+---------+
                             |
               +-------------+-------------+
               |                           |
    +----------v----------+   +-----------v-----------+
    |  Tailwind utilities  |   |  Framer Motion themes  |
    |  (bg-surface-*, etc) |   |  (color from CSS vars) |
    +----------+----------+   +-----------+-----------+
               |                           |
    +----------v---------------------------v----------+
    |                  React Components                |
    |  AuthGate, ThinkingView, EvidencePanel,         |
    |  PlanKanban, SettingsPanel                       |
    +----------+---------------------------+----------+
               |                           |
    +----------v----------+   +-----------v-----------+
    |   Zustand Stores     |   |   packages/auth       |
    |  auth, preferences,  |   |   AuthManager          |
    |  session             |   |   KeychainTokenStore    |
    +----------+----------+   +-----------+-----------+
               |                           |
    +----------v---------------------------v----------+
    |              packages/db (Convex)                |
    |  ConvexClientWrapper                             |
    |  - Session tracking                              |
    |  - Usage aggregation                             |
    |  - Preference sync                               |
    +--------------------------------------------------+
```

## Key Design Decisions

1. **Auth is non-blocking**: AuthGate renders children immediately, shows auth status as overlay/badge
2. **Local-first**: All features work without auth. Convex is additive, not required.
3. **Token-based theming**: All colors from CSS custom properties, swappable via `.dark`/`.light` class
4. **Framer Motion**: Used for enter/exit animations, layout transitions, and the thinking dot grid
5. **Zustand over Context**: Consistent with existing session-store pattern, better for frequent updates
