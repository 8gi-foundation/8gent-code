# Phase 3: CLUI Integration -- Project Brief

## Overview

Phase 3 integrates the authentication system (`packages/auth`) and advanced agent visualization components (ThinkingView, EvidencePanel, PlanKanban) into the 8gent CLUI desktop application (`apps/clui`). This creates a cohesive, branded experience where authenticated users get cloud sync via Convex, while anonymous users retain full local functionality.

## Problem Statement

The CLUI scaffold (Phase 1) provides the Tauri + React shell with session management, and the auth package (Phase 2) provides Clerk device-flow authentication and Keychain token storage. However, these systems are not yet connected:

- No auth gate or login flow in the CLUI
- No real-time Convex sync for sessions, preferences, or usage
- The TUI's rich agent visualization (thinking animation, evidence collection, plan kanban) has no GUI equivalent
- No settings panel for model selection, theme, or account management

## Goals

1. **Auth integration**: Wire `AuthManager` into the CLUI with a non-blocking auth gate (anonymous mode always works)
2. **Agent visualization**: Adapt ThinkingView, EvidencePanel, and PlanKanban from Ink/TUI to React DOM with Framer Motion animations
3. **Cloud sync**: Real-time Convex sync for session tracking, usage stats, and preferences when authenticated
4. **Settings**: Model selection, theme toggle, keyboard shortcuts reference
5. **State management**: Zustand stores for auth and preferences with local-first, cloud-sync architecture

## Non-Goals

- Full drag-and-drop kanban (future)
- Billing/payment integration
- Multi-user collaboration features
- Mobile/responsive layout (desktop-only Tauri app)

## Success Criteria

- Anonymous user can launch CLUI, run sessions, see thinking/evidence/kanban views -- zero friction
- Authenticated user sees avatar in title bar, sessions sync to Convex, preferences persist across devices
- Login flow opens browser, shows device code, completes without blocking the UI
- All components use CSS custom properties from tokens.css -- no hardcoded gray/white/black
- Framer Motion animations respect `prefers-reduced-motion`
