# Phase 3: CLUI Integration -- Product Requirements Document

## 1. Auth Gate

### Requirements
- **FR-1.1**: If not authenticated, show a non-blocking login prompt with device code flow
- **FR-1.2**: If authenticated, display user avatar + display name in the title bar
- **FR-1.3**: Anonymous mode must always be available -- skip auth, show "Anonymous" badge
- **FR-1.4**: Login/Logout buttons in both the auth gate and settings panel
- **FR-1.5**: Auth state persists across app restarts via Keychain token storage

### UX Flow
1. App launches -> AuthManager.initialize()
2. If stored token is valid -> authenticated state, show avatar
3. If no token -> anonymous mode, subtle "Sign in" link in title bar
4. User clicks "Sign in" -> device code displayed, browser opens
5. User completes OAuth in browser -> CLUI auto-detects, transitions to authenticated
6. User clicks "Sign out" -> clears token, returns to anonymous

## 2. Agent Visualization

### ThinkingView (FR-2.x)
- **FR-2.1**: Animated dot grid with ripple effect (CSS/Framer Motion, not canvas)
- **FR-2.2**: Cycling status text ("Planning approach...", "Analyzing context...", etc.)
- **FR-2.3**: Real-time counters: steps completed, tools used, processing stage
- **FR-2.4**: Elapsed timer
- **FR-2.5**: Override status when a specific tool is active

### EvidencePanel (FR-3.x)
- **FR-3.1**: Collapsible panel on the right side of the session view
- **FR-3.2**: Evidence badges with pass (green) / fail (red) indicators
- **FR-3.3**: Evidence items grouped by type with summary counts
- **FR-3.4**: Confidence meter (progress bar with color coding)
- **FR-3.5**: Expandable detail view for each evidence item
- **FR-3.6**: Real-time updates as agent collects evidence

### PlanKanban (FR-4.x)
- **FR-4.1**: Four columns: Planned -> In Progress -> Done -> (overflow hidden)
- **FR-4.2**: Cards with category icons, priority badges, confidence indicators
- **FR-4.3**: Auto-advancement: cards move columns as agent completes steps
- **FR-4.4**: Toggle visibility with Cmd+K
- **FR-4.5**: Compact/expanded modes
- **FR-4.6**: Footer with total/active/ready counts

## 3. Settings Panel

### Requirements
- **FR-5.1**: Overlay panel triggered by Cmd+, (comma)
- **FR-5.2**: Model selection: Ollama models, OpenRouter, LM Studio endpoints
- **FR-5.3**: Theme toggle: dark / light / system
- **FR-5.4**: Auth status display with login/logout actions
- **FR-5.5**: Usage stats from Convex (tokens used, sessions, time)
- **FR-5.6**: Keyboard shortcuts reference
- **FR-5.7**: Close with Escape or Cmd+,

## 4. Convex Sync

### Requirements
- **FR-6.1**: Session start/end tracking with token counts
- **FR-6.2**: Usage aggregation (daily/weekly/monthly)
- **FR-6.3**: Preference sync on login (local wins, cloud syncs)
- **FR-6.4**: Offline queue: mutations queued when offline, flushed on reconnect
- **FR-6.5**: All sync is non-blocking -- failures never crash the app

## 5. Non-Functional Requirements

- **NFR-1**: All colors from CSS custom properties (tokens.css), no gray/white/black
- **NFR-2**: Framer Motion animations respect prefers-reduced-motion
- **NFR-3**: TypeScript strict mode, no `any` in public APIs
- **NFR-4**: Components follow existing CLUI patterns (Tailwind utilities, semantic classes)
- **NFR-5**: Auth is always optional -- every feature works in anonymous mode
