# Phase 3: CLUI Integration -- Epics & Stories

## Epic 1: Auth Integration

### E1-S1: Auth Store
- Create `stores/auth-store.ts` with Zustand
- Wrap AuthManager lifecycle (initialize, login, logout)
- Expose: user, isAuthenticated, isLoading, error
- Subscribe to AuthManager.onStateChange for reactive updates

### E1-S2: Auth Gate Component
- Create `components/AuthGate.tsx`
- Non-blocking: always renders children
- Shows login prompt when anonymous (subtle, not modal)
- Device code display during login flow
- Avatar + name in title bar when authenticated
- Login/Logout buttons

### E1-S3: Convex Sync Hook
- Create `hooks/useConvexSync.ts`
- Wire ConvexClientWrapper token provider to AuthManager
- Session start/end tracking mutations
- Usage stats queries
- Preference sync on auth state change
- Offline queue handling

## Epic 2: Agent Visualization

### E2-S1: ThinkingView
- Create `components/ThinkingView.tsx` for React DOM
- Animated dot grid with CSS animations (ripple from center)
- Cycling status phases with real tool override
- Step/tool counters and elapsed timer
- Framer Motion enter/exit transitions

### E2-S2: EvidencePanel
- Create `components/EvidencePanel.tsx` for React DOM
- Collapsible sidebar with evidence badges
- Pass/fail indicators with type grouping
- Confidence meter progress bar
- Expandable detail view per item
- Summary counts footer

### E2-S3: PlanKanban
- Create `components/PlanKanban.tsx` for React DOM
- Three visible columns: Planned, In Progress, Done
- Cards with category icons and priority badges
- Auto-advancement animation when status changes
- Compact mode toggle
- Footer with aggregate counts

## Epic 3: Settings & Preferences

### E3-S1: Preferences Store
- Create `stores/preferences-store.ts` with Zustand
- Local preferences: theme, model, hotkeys
- Persist to localStorage
- Sync to Convex when authenticated (local wins)
- Merge strategy on login

### E3-S2: Settings Panel
- Create `components/SettingsPanel.tsx`
- Overlay panel (Cmd+, toggle)
- Sections: Model, Theme, Auth, Usage, Shortcuts
- Model selector with provider groups
- Theme toggle (dark/light/system)
- Auth status with login/logout
- Usage stats display
- Keyboard shortcuts reference table

## Epic 4: App Integration

### E4-S1: Update App.tsx
- Wrap with AuthGate
- Integrate ThinkingView into SessionPanel
- Add EvidencePanel as collapsible sidebar
- Add PlanKanban as toggle view (Cmd+K)
- Add SettingsPanel overlay (Cmd+,)
- Show auth status in TitleBar
- Wire new keyboard shortcuts

## Dependency Order

```
E1-S1 (auth-store) -> E1-S2 (AuthGate) -> E1-S3 (ConvexSync)
E2-S1 (ThinkingView) \
E2-S2 (EvidencePanel)  > independent, can parallelize
E2-S3 (PlanKanban)    /
E3-S1 (preferences-store) -> E3-S2 (SettingsPanel)
All above -> E4-S1 (App integration)
```
