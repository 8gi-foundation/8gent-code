---
title: 8gent Computer - UX and accessibility spec (v1)
status: RFC
owner: Moira (8DO)
reviewers: Rishi (8TO), Karen (8SO), Zara (8MO)
parent_prd: https://github.com/8gi-foundation/8gent-code/issues/1746
architecture: docs/prd/8gent-computer/architecture.md
voice_ipc: docs/prd/8gent-computer/voice-ipc.md
issue: https://github.com/8gi-foundation/8gent-code/issues/1749
date: 2026-04-24
---

# 8gent Computer - UX + a11y spec (v1)

RFC for James. Do not build yet. This is the UX contract against which the Swift implementation (Phase 1 menubar, Phase 2 main window and consent, Phase 3 memory + sessions + browser + settings) will be written. No Swift code in this doc.

## 0. Headline verdict

**Go with caveats.** The seven surfaces hold together if we keep the menubar as the only always-on foreground and reserve every other surface behind an explicit user intent.

Two decisions locked by James on 2026-04-24 (override prior v1 draft):

- **Theme inheritance, not Match System.** Default theme is inherited from 8gentOS (`8gi-foundation/8gent-OS`) and the AI James OS parent (`~/Myresumeportfolio/`), governed by `BRAND.md`. Default on first launch is **dark** (8gentOS developer default), not the macOS system appearance. Tokens, typography, palette, and component grammar pull from the same source-of-truth as 8gentOS. The light/dark toggle still exists and persists. Detail in section 3.5.
- **Floating window is draggable, not dock-anchored.** When the main window is closed, the compact 8gent Computer surface is a free-floating window the user can drag anywhere on screen, persisted across launches and per-display. Detail in section 11.6. Dock presence remains (`LSUIElement = false`); see section 11.4.

One remaining judgment call, flagged inline:

- The consent sheet is a *sheet attached to the foreground window*, never a floating alert and never a system-level notification. Non-focus-stealing policy holds except for the single consent modal tied to an action the user just initiated.

## 1. Core problem, constraint, non-goals

- **Problem**: a Mac app that orchestrates local agents across memory, computer-use, voice, and scheduling has seven distinct surfaces that cannot all live in one window without turning into a dashboard mess. A user should be able to do five things (summon agent, grant one consent, read memory, manage sessions, change a setting) in under ten seconds each without reading documentation.
- **Constraint**: accessibility and calm. The app must pass VoiceOver rotor navigation end-to-end, respect `NSAccessibility` protocol on every custom view, and never steal focus except for consent tied to a user-initiated action. No notification flashes, no badge pulses, no motion in ADHD mode.
- **Not doing in v1**:
  - Custom theme editor. Light and dark only.
  - Keyboard-only rebind UI. Shortcuts are fixed in v1.
  - Multi-window. One main window, one popover, one consent sheet, one per-session browser tab inside main. Additional windows deferred.
  - Drag-to-rearrange session cards. Grid is ordered by recency.
  - Localization. English only in v1. Copy strings are isolated for later extraction.
  - Touch Bar. Intel Macs with Touch Bar are Phase 2 hardware targets at best.

## 2. Surface inventory (the seven, plus a floating compact view)

| # | Surface                           | Persistence                          | Summoned how                                   |
|---|-----------------------------------|--------------------------------------|------------------------------------------------|
| 1 | NSStatusBar menu-bar item         | Always visible while app is running  | Login item, or `open -a "8gent Computer"`      |
| 2 | Main window                       | User-summoned, persists until closed | Click status item, or global hotkey, or deep link |
| 3 | Consent sheet                     | Ephemeral, one at a time             | Agent attempts a policy-gated action           |
| 4 | Memory viewer                     | Pane inside main window              | Sidebar item in main window                    |
| 5 | Session manager                   | Pane inside main window              | Sidebar item in main window                    |
| 6 | In-app browser tab                | Tab inside Session pane              | Agent opens a URL, or user clicks a URL there  |
| 7 | Settings                          | Pane inside main window              | Sidebar item, or Cmd+Comma                     |
| 8 | Floating compact window (new)     | Shown when main window is closed     | Auto when main window closes; repositionable and persisted per-display |

Surfaces 4, 5, 6, 7 are panes inside the single main window (surface 2), not separate windows. Surface 3 (consent) is a sheet attached to the currently focused window, or to a minimal consent host window if no window is open. Surface 8 (floating window) is detailed in section 11.6.

## 3. Shared visual system

Tokens, spacing, motion, and palette live at the app level. No surface overrides these without naming the token it is overriding and why.

### 3.1 Palette

All tokens from `BRAND.md`. Warm only. Banned hues 270-350.

| Token            | Light mode | Dark mode |
|------------------|------------|-----------|
| `--bg-0`         | `#FFFDF9`  | `#0A0908` |
| `--bg-1`         | `#FFF8F0`  | `#12100E` |
| `--bg-2`         | `#FFF3E8`  | `#1C1A17` |
| `--bg-3`         | (derive)   | `#252220` |
| `--text-primary` | `#1A1612`  | `#FAF7F4` |
| `--text-secondary`| `#5C544A` | `#C8C2BA` |
| `--text-tertiary`| `#9A9088`  | `#8A8078` |
| `--border`       | `#E8E0D6`  | `#2E2A26` |
| `--accent`       | `#E8610A`  | `#F07A28` |
| `--heartbeat-ok` | `#1F7A3F`  | `#3FA362` (warm-leaning green, not cyan-green) |
| `--heartbeat-warn`| `#C87A14` | `#E8A246` (amber, distinct from accent via saturation) |
| `--heartbeat-bad`| `#B03020`  | `#D14838` (red-orange, warm) |

Status colours never appear alone. Every status colour pairs with a text label and a shape token (dot, ring, slash). This is WCAG 2.2 SC 1.4.1 (color not the only means).

### 3.2 Typography

- Wordmark in app only where brand-critical (About window, launch splash if any). Fraunces 800.
- Everything else is Inter. Body 13pt, secondary 11pt, monospace JetBrains Mono 12pt for logs and transcripts.
- Minimum text size honours the system `AppleMetricsPreferredContentSize` scaling, clamped to 110% upper bound for v1 (a dedicated "Larger text" toggle is Phase 2).

### 3.3 Motion

- Default transitions: 200ms ease-out. Sheet presentation: 240ms. Menu popover fade: 150ms.
- `prefers-reduced-motion` (via `NSWorkspace.shared.accessibilityDisplayShouldReduceMotion`) flips all motion durations to 0ms. No fades. Instant present, instant dismiss.
- ADHD mode (section 3.6) is a superset of reduced motion. It also collapses transcript streaming animations to full-message appearance (no typewriter, no scroll-jump).

### 3.4 Spacing

8pt base grid. Sidebar widths on main window: 240pt. Detail pane widths: 360pt. Sheet width: 520pt. All values mirror the abilities 3D spec for consistency across products.

### 3.5 Theme inheritance and defaults

**Locked 2026-04-24 (James).** 8gent Computer does not default to Match System. It is a member of the 8gent ecosystem and inherits its theme from the same source-of-truth as 8gentOS and the AI James OS parent.

**Source-of-truth precedence:**

1. `BRAND.md` at the root of this repo (`/Users/jamesspalding/8gent-code/BRAND.md`). Typography (Fraunces 800 wordmark, Fraunces 700 headings, Inter 400-600 body, JetBrains Mono code). Palette (warm only, banned hues 270-350). Accent `#E8610A` light / `#F07A28` dark.
2. `8gi-foundation/8gent-OS` (the Next.js per-user OS at `{user}.8gentOS.com`). The same CSS token names used there (`--bg-0..3`, `--text-primary/secondary/tertiary`, `--border`, `--accent`, `--heartbeat-*`) are the token names used here. The Swift implementation reads the same token-name contract and maps to native colours.
3. `~/Myresumeportfolio/` (AI James OS parent). Cross-checked so that a user moving between the native app and the parent web surfaces does not feel a brand drop.

Component grammar (button shapes, sidebar widths 240pt, sheet widths 520pt, 8pt spacing grid, 200ms ease-out motion) tracks 8gentOS. A user moving between `{user}.8gentOS.com` in a browser tab and the native 8gent Computer window should feel continuity, not translation.

**Defaults:**

- **First-launch theme: dark.** Matches the 8gentOS developer default per `BRAND.md` § Default Themes.
- `NSApplication.effectiveAppearance` is **not** used to pick the default. The app is brand-themed, not system-themed. This is a deliberate departure from typical macOS etiquette in exchange for ecosystem consistency with 8gentOS.
- `prefers-color-scheme` is respected only where a web sub-view renders its own theme (the in-app browser tab, surface 6), per section 9.5.

**User override:**

- A visible theme toggle lives in Settings under Appearance. Values in v1: Dark (default), Light. No Match-System value in v1.
- Also reachable via View menu > Theme > Dark / Light.
- Persisted in `~/.8gent/config.json` under `app.theme`. If the key is missing on launch, the app falls back to Dark.
- The toggle is mirrored in a compact form in the floating window (section 11.6) so it can be flipped without opening Settings. The ADHD-mode toggle lives next to it, same placement, per the accessibility-primitives standard.

**Consequence for the architecture doc:** the Swift implementation must import token names from a shared source. The shared-tokens package lives at `packages/brand-tokens/` (new, Phase 1 infra), generated from `BRAND.md`, consumed by both the Next.js 8gentOS app and the Swift app. Drift between 8gentOS and 8gent Computer is a P1 bug.

### 3.6 ADHD mode

ADHD mode is a single toggle in Settings > Appearance. When on:

- Reduced motion applies (superset).
- Streaming text renders as full messages, no token-by-token appear.
- Parallel session cards collapse to a single-column list sorted by most recent. No grid.
- Notification badge (section 9) is suppressed. The menu-bar dot still shows, but stays steady (no pulse).
- Copy is shortened wherever a plainer version exists. Button labels stay identical.
- No color-only emphasis. Every accent-coloured element also carries an icon or label change.

ADHD mode is persisted and restored across launches. It does **not** infer from any other system setting - it is an explicit user opt-in. Reason: ADHD is not a system appearance flag, and guessing would be wrong.

## 4. Surface 1 - NSStatusBar menu-bar item

### 4.1 Purpose

Always-visible heartbeat and summoner. Shows whether the daemon is alive, how many sessions are running, and gives one-click access to the main window.

### 4.2 Layout

```
                        [ 8 ]   <- status bar item, 18pt icon
                        /   \
                       /     \
            click (left)      right-click
                 |                |
         +----------------+  +--------------------+
         | Popover (320)  |  | Context menu       |
         |                |  |                    |
         | 8gent Computer |  | Open window        |
         | Daemon: OK     |  | Pause all sessions |
         | 2 sessions     |  | Open preferences   |
         |                |  | ---                |
         | [Open window]  |  | About              |
         | [Pause all]    |  | Quit               |
         +----------------+  +--------------------+
```

The icon is the numeral 8 set as a monochrome template image (`isTemplate = true`), which means macOS handles light/dark tinting automatically. A small dot overlays the bottom-right corner for heartbeat state:

- Green dot: daemon healthy, at least one session alive or idle and ready.
- Amber dot: daemon healthy, no sessions, or reconnecting.
- Red dot: daemon unreachable.

### 4.3 Interaction model

- Left click: opens a 320pt-wide popover anchored to the status item. Popover contains the heartbeat summary and two primary buttons.
- Right click (or control-click): opens a classic `NSMenu` with Open window, Pause all sessions, Open preferences, About, Quit.
- The popover closes on outside click, Escape key, or window focus change.
- No keyboard shortcut directly on the status item (macOS does not expose these). Global hotkey (section 10) handles keyboard summoning.

### 4.4 States

| State               | Icon     | Dot    | Popover headline                  |
|---------------------|----------|--------|-----------------------------------|
| Daemon OK, 0 sessions | 8 | amber | "Daemon ready. No active sessions." |
| Daemon OK, N sessions | 8 | green | "Daemon ready. N sessions running." |
| Reconnecting        | 8 | amber | "Reconnecting..."                  |
| Daemon unreachable  | 8 | red   | "Daemon not reachable. Last seen {time}." |
| First launch, no daemon | 8 (dimmed) | red | "Daemon not started. Start 8gent Code first." |

### 4.5 Accessibility

- The status item has `accessibilityLabel = "8gent Computer status"` and `accessibilityValue` bound to the current state string. VoiceOver announces e.g. "8gent Computer status, Daemon ready, two sessions running, button".
- Popover buttons carry explicit `accessibilityLabel` values: "Open main window" and "Pause all sessions". No reliance on icons alone.
- Keyboard focus in the popover moves in source order: heartbeat summary (read-only), Open main window, Pause all sessions.
- VoiceOver narration, first-time open flow: user focuses menu bar (VO+M, F8), arrows to 8gent Computer, VO reads "8gent Computer status, Daemon ready, zero sessions, button". User presses VO+Space to click. Popover opens. Focus lands on Open main window. VO reads "Open main window, button".
- Light/dark: monochrome template icon auto-tints. Heartbeat dot uses the status tokens from 3.1 and is always paired with the popover text label, never colour-only.
- ADHD mode: no change to the icon. The amber "reconnecting" state does not animate (no spinner). Static dot with popover text.
- `prefers-reduced-motion`: popover open/close is instant.

### 4.6 Copy notes

- Open main window (button)
- Pause all sessions (button)
- Resume all sessions (button, replaces Pause when paused)
- "Daemon ready. No active sessions." (empty state)
- "Daemon ready. N sessions running." (healthy)
- "Reconnecting..." (transient)
- "Daemon not reachable. Last seen {time}." (error, include local time)
- "Start 8gent Code to bring the daemon online." (first-launch help line, clickable and opens a help URL)

## 5. Surface 2 - Main window

### 5.1 Purpose

Home base. The one window from which a user can see every session, every memory, every consent record, and every setting. Not a dashboard - a workspace. Sidebar + content pane.

### 5.2 Layout

Single resizable window, minimum 960 x 640, default 1200 x 800. Sidebar on left (fixed 240pt), content pane on right (flexible). Standard macOS traffic lights, unified title bar.

```
+----------------------------------------------------------+
| [x] [ ] [ ]   8gent Computer                     [toolbar]|
+----------------------------------------------------------+
|              |                                           |
|  Sessions    |                                           |
|  Memory      |                                           |
|  Abilities   |        (content pane, driven by           |
|  Schedule    |         selected sidebar item)            |
|  Browser     |                                           |
|  Settings    |                                           |
|              |                                           |
|              |                                           |
|  [+] New     |                                           |
|              |                                           |
|  --- footer -|                                           |
|  Daemon: OK  |                                           |
+----------------------------------------------------------+
```

Sidebar items, top to bottom:

- **Sessions** (default selected). Opens the Session Manager pane (surface 5).
- **Memory**. Opens Memory Viewer (surface 4).
- **Abilities**. Opens a read-only list of the agent's abilities, links to the web abilities page.
- **Schedule**. Opens routine / cron list, backed by `packages/cron/routines.ts`.
- **Browser**. Opens the In-app browser pane (surface 6) on its own, outside a session context.
- **Settings**. Opens Settings (surface 7). Cmd+Comma jumps here.

Footer shows daemon status with a small dot and the short text "Daemon: OK" or "Daemon: reconnecting" or "Daemon: offline". Click on the footer scrolls to settings > Daemon or surfaces a minimal diagnostic.

### 5.3 Interaction model

- Single click on sidebar item switches the content pane.
- Cmd+1 through Cmd+6 are the keyboard shortcuts for the six sidebar items in order (Sessions through Settings).
- Cmd+N creates a new session (same as [+] New button). Focus lands inside the new session's prompt input.
- Cmd+W closes the main window but keeps the app running (menu-bar item persists). Cmd+Q quits the app.
- Cmd+F in any pane opens that pane's find field (see each surface section).
- Esc closes any active sheet or popover but does not navigate between panes.

### 5.4 States

| State              | What the user sees                                                      |
|--------------------|-------------------------------------------------------------------------|
| First-launch, empty | Sessions pane with a welcome card: "No sessions yet. Create one to start." |
| Healthy            | Sidebar + selected pane render normally.                                 |
| Daemon offline     | Top of content pane shows a dismissable banner: "Daemon is not reachable. Some actions will fail." Retry button on the right. |
| Loading pane       | Content pane shows a skeleton: three greyed rows, no spinner. 200ms delay before skeleton renders (no flicker on fast loads). |
| Error inside pane  | Content pane shows a plain error card: title + one-line reason + Retry button. Errors are never modal. |

### 5.5 Accessibility

- Sidebar is an `NSOutlineView` (or SwiftUI equivalent) with `accessibilityRole = .list`. Each item has a label, a selection state, and a keyboard-navigable focus.
- Tab order on main window: sidebar list, then content pane, then footer. Shift+Tab reverses.
- VoiceOver narration, first-time open flow: window gains focus, VO reads "8gent Computer, window". First Tab moves to sidebar. VO reads "Sessions, 1 of 6, selected, list". Up and down arrows move through items; VO reads each.
- All sidebar items have static labels (no icons-only). Cmd+1 through Cmd+6 have menu equivalents under a View menu item so users discover them.
- Light/dark tokens from section 3.1. Sidebar bg uses `--bg-1`, content pane uses `--bg-0`, borders `--border`.
- ADHD mode: no change to layout. Loading skeletons remain static (no shimmer). Daemon-offline banner text stays non-animated.
- `prefers-reduced-motion`: pane transitions are instant. No slide-in on pane change.

### 5.6 Copy notes

- Sessions, Memory, Abilities, Schedule, Browser, Settings (sidebar items; these are the canonical labels)
- + New (button in sidebar footer; adds a session)
- Daemon: OK / Daemon: reconnecting / Daemon: offline (footer)
- "No sessions yet. Create one to start." (empty state, Sessions pane)
- "Daemon is not reachable. Some actions will fail." (banner) + Retry (button)
- "Could not load. Try again." (generic pane error) + Retry (button)

## 6. Surface 3 - Consent sheet

### 6.1 Purpose

Single-purpose modal that asks the user to approve one action the agent wants to take against a specific bundle-id, with the option to remember the decision for future same-kind actions. Per PRD: first time per bundle-id per action-kind. This is the only surface allowed to interrupt focus, and only when the user has just asked the agent to do something that triggers it.

### 6.2 Layout

Sheet attached to the currently focused window (typically the main window). If no window is open, a minimal host window is created, brought forward, and the sheet attaches. Sheet is 520pt wide, auto-height, no traffic lights of its own.

```
+------------------------------------------------+
|  [icon 48]   Safari wants to take a screenshot |
|                                                 |
|   The agent is attempting: Screenshot           |
|   Target app: Safari (com.apple.Safari)         |
|   Session: dinner-reservation (s_abc123)        |
|                                                 |
|   Reason from the agent:                        |
|   "I need to read the booking form to fill      |
|    your name and email."                        |
|                                                 |
|   [ ] Remember this choice for Safari           |
|                                                 |
|                   [ Deny ]   [ Allow once ]    |
+------------------------------------------------+
```

Icon is the target app's `NSWorkspace.shared.icon(forFile:)` render, or a fallback generic app icon. Headline is one sentence, verb-forward, naming the app.

### 6.3 Interaction model

- Default focus on Deny. Users press Return to deny, not allow. This is a deliberate safety bias.
- Tab cycles: Remember checkbox, Deny button, Allow once button.
- Esc key denies and closes the sheet.
- Cmd+D denies. Cmd+Shift+A allows (requires modifier to prevent slips).
- If "Remember this choice for Safari" is checked, the verdict is written to `packages/permissions/policy-engine.ts` as a rule keyed on `(bundleId, actionKind)`. The checkbox label updates to name the specific bundle-id.
- If the user switches apps while a sheet is open, the sheet does not follow. The agent waits. Returning to the 8gent Computer app brings the sheet back into focus.

### 6.4 States

| State           | What the user sees                                                    |
|-----------------|-----------------------------------------------------------------------|
| Idle            | Full sheet as above.                                                  |
| Policy loading  | Buttons disabled for 200ms max while policy engine is being queried. Skeleton placeholder on the reason line if reason is still loading. |
| Error           | Sheet stays open with a one-line error under the buttons: "Policy engine did not respond. Action denied automatically in 5s." Countdown visible, denies and closes on timeout. |
| Success (allow) | Sheet dismisses with 200ms fade. Agent proceeds. |
| Success (deny)  | Sheet dismisses with 200ms fade. Agent is told deny, returns to the session. |

### 6.5 Accessibility

- Sheet has `accessibilityRole = .dialog`. VoiceOver announces "Permission request, dialog" on present.
- VO narration, first-time flow: sheet opens, VO reads the headline, then the two lines below (target app, session), then the reason, then the Remember checkbox label, then the two buttons in order. Focus lands on Deny. User presses space to deny, or tabs to Allow once.
- ARIA/AX labels (explicit):
  - Headline: `accessibilityLabel = "{AppName} wants to {actionLabel}"`, `accessibilityRole = .staticText`
  - Icon: `accessibilityLabel = "{AppName} icon"`, `accessibilityRole = .image`, decorative-but-named
  - Reason block: `accessibilityLabel = "Agent reason: {reason}"`
  - Remember checkbox: `accessibilityLabel = "Remember this choice for {AppName}"`, `accessibilityValue = "off"` or `"on"`
  - Deny button: `accessibilityLabel = "Deny"`
  - Allow once button: `accessibilityLabel = "Allow once"` (always says "once" even if Remember is checked, to keep button label unambiguous; Remember is a separate commitment)
- Focus trap: focus cannot leave the sheet by tabbing. Shift+Tab from the first focusable item wraps to the last.
- ADHD mode: sheet present/dismiss is instant, no fade. Error-state countdown still runs, but its visible text updates per second, no animated ring.
- Light/dark: sheet bg uses `--bg-2`, title uses `--text-primary`, reason block uses `--text-secondary`. Deny button uses default macOS secondary style. Allow once uses `--accent` as the bezel tint but never as the only signal (the word "Allow" is the signal).

### 6.6 Copy notes

- "{AppName} wants to {actionLabel}" (headline; examples: "Safari wants to take a screenshot", "Xcode wants to control keyboard and mouse")
- "The agent is attempting: {actionLabel}" (subtitle first line)
- "Target app: {AppName} ({bundleId})" (subtitle second line)
- "Session: {sessionName} ({sessionId})" (subtitle third line)
- "Reason from the agent:" (label above the reason block)
- "Remember this choice for {AppName}" (checkbox)
- Deny (button)
- Allow once (button)
- "Policy engine did not respond. Action denied automatically in {n}s." (error state)

## 7. Surface 4 - Memory viewer

### 7.1 Purpose

Browse and search what the agent remembers. Two backing stores per architecture doc: SQLite FTS5 (`packages/memory/`) and Qdrant (HTTP at 127.0.0.1:6333). Users can search, filter by tier and retention, inspect a single memory, and forget individual or filtered sets.

### 7.2 Layout

Pane inside main window, using a two-column layout: list on the left (flexible width, collapsible to 320pt), detail on the right (flexible width, 400pt min).

```
+------------------+-----------------------------------+
|  [search box ]   |  Memory detail                    |
|  [filters    ]   |                                   |
|                  |  Title: "dinner plans with J"     |
|  - hit 1         |  Tier: short-term                 |
|  - hit 2         |  Retention: 7 days                |
|  - hit 3         |  Created: 2026-04-22 18:12        |
|  - ...           |  Session: dinner-reservation      |
|                  |                                   |
|                  |  --- content ---                  |
|                  |  (full text)                      |
|                  |                                   |
|                  |  [ Forget this memory ]           |
+------------------+-----------------------------------+
```

Filters (compact chip row above the list): Tier (short-term / long-term / all), Retention (7d / 30d / 90d / forever / all), Source (SQLite / Qdrant / both). Default filters = all.

### 7.3 Interaction model

- Cmd+F focuses the search input.
- Typing in search debounces at 200ms, then fires `memory:search` over the daemon WebSocket.
- Arrow keys move selection up/down in the list. Return or space opens the detail pane to that memory. (In the split-view it is already visible; Return commits focus to the detail.)
- Cmd+Delete forgets the selected memory. Single-step with undo toast in the top-right of the pane ("Forgot. Undo"). 6 second undo window.
- "Forget filtered set" button at the bottom of the list, shown only when a non-default filter is applied. Confirm sheet attaches before forgetting more than 10 items.
- Tier filter never forgets long-term memories without a typed confirmation ("type 'forget long-term' to confirm"). Mandatory friction for destructive long-term deletes.

### 7.4 States

| State              | What the user sees                                                    |
|--------------------|-----------------------------------------------------------------------|
| Empty (fresh install) | "No memories yet. They will appear here as the agent works."       |
| Loading             | Skeleton rows (5 rows), 200ms delay.                                 |
| Results             | List of hits with title, tier chip, relative time.                   |
| No match            | "No memories match '{query}'. Try a broader term."                   |
| Error               | Error card in the list area, Retry button.                            |
| Qdrant unreachable  | Banner at top of pane: "Vector search is unavailable. Showing text-search results only." |

### 7.5 Accessibility

- Search input has `accessibilityLabel = "Search memories"`, placeholder "Search memories".
- List has `accessibilityRole = .list`. Each row carries `accessibilityLabel = "{title}, tier {tier}, {relativeTime}"` and `accessibilityHint = "Double tap to view details"`.
- Detail pane title uses `accessibilityRole = .heading`, level 2.
- Forget button uses `accessibilityLabel = "Forget this memory"` plus `accessibilityRole = .button`. Undo toast uses `accessibilityLabel = "Memory forgotten. Undo available for 6 seconds."`
- Focus order: search input, filter chips (left to right), list (first result), detail pane heading, content, forget button.
- VO narration, search flow: user focuses search, types query. 200ms after last keystroke, VO announces "{n} results" via `NSAccessibility.post(element:notification: .announcement)`. User tabs to list, arrows to first result.
- Light/dark tokens as section 3.1. Tier chips use `--bg-2` background, `--text-secondary` text, `--border` outline.
- ADHD mode: debounce bumps to 400ms (less eager re-render). List sort stays chronological by default, not relevance (familiar order). No result-count animation.
- `prefers-reduced-motion`: undo toast slides in replaced by instant appear/disappear.

### 7.6 Copy notes

- Search memories (input placeholder)
- Tier / Retention / Source (filter chip group labels)
- All / Short-term / Long-term (tier chip values)
- Forget this memory (button)
- Forget filtered set (button, only appears with non-default filter)
- Forgot. Undo (toast)
- "No memories yet. They will appear here as the agent works." (empty state)
- "No memories match '{query}'. Try a broader term." (no match)
- "Vector search is unavailable. Showing text-search results only." (degraded state)
- "Type 'forget long-term' to confirm." (destructive confirm input placeholder)

## 8. Surface 5 - Session manager

### 8.1 Purpose

Show every active agent session as a card, let the user open, pause, or kill each, and surface per-session state (running, waiting on consent, idle, errored). Up to 10 concurrent per `packages/daemon/agent-pool.ts`.

### 8.2 Layout

Pane inside main window. Grid of cards on the left (2 columns at 1200pt width, 1 column below 960pt), selected session's full detail on the right.

```
+---------------------------+---------------------------+
|  Sessions (2/10)          |  Session: dinner-reservation  |
|                           |                               |
|  +---------+ +---------+  |  State: running               |
|  | s_abc   | | s_xyz   |  |  Started: 2 min ago           |
|  | running | | waiting |  |                               |
|  | dinner  | | refund  |  |  [ transcript streaming ]     |
|  | 2m ago  | | consent |  |  ...                          |
|  +---------+ +---------+  |                               |
|                           |                               |
|  [ + New session  ]       |  [Pause] [Kill] [Open browser]|
+---------------------------+---------------------------+
```

Each card is 240pt x 140pt. It shows session id short-form (8 chars), state chip, human-readable title (derived from the first user message or the user-set title), and relative time.

In ADHD mode the grid collapses to a one-column list sorted by most recent, no state chips coloured, state shown as label only.

### 8.3 Interaction model

- Single click on a card selects it and populates the detail pane.
- Double click on a card opens it in a full-pane mode (detail expands, grid collapses). Cmd+Return does the same from keyboard focus.
- Cmd+N creates a new session, same as the main window shortcut. Focus lands in the new session's transcript input.
- Per-card context menu (right-click): Open, Pause, Resume, Kill, Rename, Open in Lil Eight (deep-links via `lileight://` if Lil Eight is installed).
- Detail pane actions: Pause, Kill, Open browser (adds the browser tab to this session). Kill requires a confirm sheet ("Kill this session? In-flight actions may not complete.") and a 3-second grace period on the kill itself (soft-kill then hard).
- Up to 10 sessions: if the user tries to create an 11th, an inline message appears: "You have 10 sessions running. Close one to start another." Never a modal.

### 8.4 States

| State             | Card visual                                               |
|-------------------|-----------------------------------------------------------|
| Running           | Green dot (per 3.1 heartbeat-ok), "running" text.        |
| Waiting consent   | Amber dot, "waiting on you" text, card has amber border `--accent`. |
| Idle              | Grey dot, "idle" text, no border.                         |
| Errored           | Red dot, "error" text, red-warm border `--heartbeat-bad`. |
| Paused            | Grey dot, slash icon, "paused" text.                      |

Grid empty state: "No sessions yet. Start one with Cmd+N or click New session."

### 8.5 Accessibility

- Grid has `accessibilityRole = .list` (not `.grid`, because macOS VO handles lists better than grids for irregular card contents in Phase 2, judgment call).
- Each card has `accessibilityLabel = "{title}, {state}, started {relativeTime}"`, `accessibilityHint = "Double tap to open session detail"`.
- State chip inside card has its own `accessibilityLabel` to make the state readable without pulling from the card label when inspected alone.
- Context menu items: Open / Pause / Resume / Kill / Rename / Open in Lil Eight.
- Focus order in the pane: grid (first card), New session button, detail pane heading, transcript content, detail pane actions.
- VO narration, open flow: user focuses grid, VO reads "Sessions, list, {n} items, {current}". Arrow moves between cards. Return opens. Detail pane heading announces "Session {title}, heading, level 2".
- Light/dark: card bg `--bg-2`, border `--border`, selected-card bg `--bg-3` with accent left-edge stripe 2pt wide. Selected state is also marked with a text prefix "Selected:" read by VO.
- ADHD mode: grid becomes single-column list, chips become text-only, accent stripes become text labels ("Selected").
- `prefers-reduced-motion`: card selection transition is instant.

### 8.6 Copy notes

- Sessions ({n}/10) (pane header)
- + New session (button)
- running / waiting on you / idle / error / paused (state labels, these are the canonical strings)
- Pause / Resume / Kill / Open / Rename / Open in Lil Eight (action labels)
- "Kill this session? In-flight actions may not complete." (confirm sheet title)
- "You have 10 sessions running. Close one to start another." (max-sessions message)
- "No sessions yet. Start one with Cmd+N or click New session." (empty state)

## 9. Surface 6 - In-app browser tab

### 9.1 Purpose

Where the agent browses the web on the user's behalf, and where the user can watch or take over. Architecture doc: WKWebView, sandboxed cookie store in v1, AX tree piped to the agent. The browser is a tab inside a session, not a separate pane - it shares context with the session's transcript.

### 9.2 Layout

Appears as a second sub-tab inside the Session detail pane. Tab row: Transcript / Browser. Browser tab content:

```
+-----------------------------------------------------+
|  [ < ] [ > ] [ reload ]  [ url bar ........ ]  [x] |
+-----------------------------------------------------+
|                                                     |
|           WKWebView render area                    |
|                                                     |
|                                                     |
|                                                     |
+-----------------------------------------------------+
|  Agent status: waiting on element #book-button      |
+-----------------------------------------------------+
```

URL bar is editable. The [x] on the right removes the browser tab from the session (not a window close).

Agent status bar at the bottom of the browser renders what the agent is doing right now in plain English (e.g. "Filling: email", "Reading the page", "Waiting for navigation"). This is the single most important trust-signal in the app.

### 9.3 Interaction model

- Cmd+L focuses the URL bar.
- Cmd+R reloads.
- Cmd+[ and Cmd+] for back and forward (standard macOS web bindings).
- If the agent and the user both try to navigate simultaneously, the user's navigation wins and the agent is told "user took over".
- Closing the browser tab stops the agent's navigation; it does not kill the session. The agent returns to the transcript.
- Highlight on page: when the agent is focused on an element (per AX tree), the element gets a 2pt dashed `--accent` outline. This is a debug-style visual and can be toggled off in Settings.

### 9.4 States

| State                     | What the user sees                                   |
|---------------------------|------------------------------------------------------|
| Idle (no URL)             | Empty state: "Ask the agent to open a page, or type a URL." |
| Loading                   | Thin progress bar at top of web view, 2pt tall.      |
| Loaded                    | Page render, agent status bar at bottom.             |
| Navigation error          | Empty state with error: "{host} could not load. {reason}." Retry button. |
| Agent paused (consent)    | Web view dims 40%, overlay text: "Waiting for your approval." |
| User took over            | Agent status bar reads: "You took over. Agent is waiting." |

### 9.5 Accessibility

- The WKWebView is bridged to VoiceOver via WebKit's native AX (already works out of the box for well-structured pages).
- URL bar has `accessibilityLabel = "URL"`, role text field.
- Back/forward/reload buttons have explicit labels and are keyboard-focusable via Tab.
- Agent status bar at the bottom uses `accessibilityLabel = "Agent status: {status}"`, `accessibilityLiveRegion = .polite`. VO announces changes without stealing focus.
- Focus order: tab row (Transcript | Browser), back, forward, reload, URL, close tab, web view, agent status.
- VO narration, first navigation: agent opens `https://example.com`. VO polite announcement: "Agent status: navigating to example.com". Page loads. VO switches to the web view's content as the user moves focus into it.
- Light/dark: chrome (URL bar, buttons) uses `--bg-2` / `--border`. Web view renders whatever the page renders; we do not force a theme.
- ADHD mode: element highlight dashed outline is disabled (plainer visual). Agent status bar still updates but without any fade transitions.
- `prefers-reduced-motion`: loading bar is a static 40% width while loading, not an indeterminate animation.

### 9.6 Copy notes

- URL (field label)
- Back / Forward / Reload (button labels)
- Close tab (button label, tooltip "Close browser tab in this session")
- "Ask the agent to open a page, or type a URL." (empty state)
- "{host} could not load. {reason}." (error)
- "Waiting for your approval." (consent-pause overlay)
- "You took over. Agent is waiting." (user-took-over)
- Agent status labels (plain English, verb-forward): "Reading the page", "Filling: {field}", "Clicking: {element}", "Waiting for navigation", "Idle"

## 10. Surface 7 - Settings

### 10.1 Purpose

One pane, five groups. No preferences window - settings live inside main window like modern macOS apps (Mail, Messages). Cmd+Comma jumps here.

### 10.2 Layout

Single scrollable pane with section headings and form rows. Sticky left sub-nav at 200pt width listing section headings, same pattern as System Settings.

```
+----------------+------------------------------------+
|                |                                    |
|  Appearance    |  Appearance                        |
|  Voice         |                                    |
|  Ethics        |  Theme:  [ Match System v ]        |
|  Apps          |  ADHD mode: [ off ]                |
|  Schedule      |                                    |
|  Daemon        |  Voice                             |
|                |  Model: [ KittenTTS v ]            |
|                |  Voice id: [ 8gent-default v ]     |
|                |  Input device: [ System default ]  |
|                |                                    |
|                |  Ethics                            |
|                |  Computer-use actions require...   |
|                |   [x] Screenshot                   |
|                |   [x] Keyboard                     |
|                |   [x] Mouse                        |
|                |   [ ] Clipboard read               |
|                |                                    |
|                |  Apps                              |
|                |  Blocked bundle IDs:               |
|                |   - com.apple.Keychain             |
|                |   - ...                            |
|                |   [ + Add... ]                     |
|                |                                    |
|                |  Schedule                          |
|                |  ...                               |
|                |                                    |
|                |  Daemon                            |
|                |  WebSocket: ws://localhost:18789   |
|                |  Status: OK                        |
|                |  [ Reconnect ] [ Restart daemon ]  |
|                |                                    |
+----------------+------------------------------------+
```

### 10.3 Interaction model

- Cmd+Comma opens Settings from anywhere in the app.
- Sub-nav is a list; clicking scrolls the pane to the section. Keyboard: arrow down/up on sub-nav to move section focus.
- All changes are immediate (no Save button). For destructive changes (e.g. removing a bundle-id from the deny list), a one-step undo toast appears.
- Ethics toggles persist to `~/.8gent/config.json` and are read by `packages/permissions/policy-engine.ts` on next action.
- App deny list is shown in alphabetical order, Add opens a small sheet to enter a bundle-id with a "Pick from running apps" option.
- Schedule section binds to `packages/cron/routines.ts`. Shows a read-only list in v1 with Edit opening the CLI in a terminal (judgment call: full in-app cron editing is Phase 2; v1 surfaces the list, directs complex editing to the TUI).
- Daemon section has Reconnect (reruns the WS handshake) and Restart daemon (sends `daemon:restart` and waits for `heartbeat` green). Restart has a confirm sheet.

### 10.4 States

| State                 | What the user sees                                           |
|-----------------------|--------------------------------------------------------------|
| Normal                | All sections rendered, all values reflect current config.    |
| Loading config        | Skeleton rows inside each section, 200ms delay.              |
| Config write failed   | Inline error row under the failing field: "Could not save. Retry." |
| Daemon unreachable    | Daemon section shows status "offline", action buttons enabled (they will queue). Other sections render normally. |

### 10.5 Accessibility

- Every form row is a labelled control. No inputs without labels.
- Sub-nav has `accessibilityRole = .list`. Each item `accessibilityLabel = "{sectionName}"`, `accessibilityHint = "Scroll to {sectionName}"`.
- Toggles have `accessibilityLabel`, `accessibilityRole = .checkbox` or `.switch`, and clearly-read `accessibilityValue` ("on" / "off").
- Theme dropdown has `accessibilityLabel = "Theme"`, `accessibilityValue` announces the current value (Match System / Light / Dark).
- ADHD mode toggle has a supplementary `accessibilityHint = "Reduces motion, collapses grids, and disables streaming text."` so a screen reader user understands the cost.
- Focus order: sub-nav (Appearance first), then pane sections top to bottom, each row in source order.
- VO narration, flipping the ADHD toggle: VO reads "ADHD mode, checkbox, off". User presses space. VO reads "ADHD mode, checkbox, on. Reduces motion, collapses grids, and disables streaming text."
- Light/dark tokens as section 3.1. Switch thumbs use `--bg-0`, track uses `--bg-2` (off) or `--accent` (on).
- ADHD mode: no change to Settings layout. Destructive-change undo toast still renders, no fade, instant appear/disappear.
- `prefers-reduced-motion`: sub-nav scroll to section is instant (no smooth scroll).

### 10.6 Copy notes

- Appearance / Voice / Ethics / Apps / Schedule / Daemon (sub-nav and section headings)
- Theme (dropdown label), Match System / Light / Dark (values)
- ADHD mode (toggle label)
- Model (voice model dropdown; "KittenTTS" is the only v1 option, per repo rule)
- Voice id (voice id dropdown)
- Input device (dropdown)
- Computer-use actions require confirmation: (section intro)
- Screenshot / Keyboard / Mouse / Clipboard read (ethics action names; canonical strings)
- Blocked bundle IDs (apps section label)
- + Add... (button)
- Pick from running apps (sheet option)
- Edit in Terminal (schedule link-out button)
- Reconnect / Restart daemon (buttons)
- "Could not save. Retry." (inline error)

## 11. Cross-surface concerns

### 11.1 Global hotkey

**Proposed: Cmd+Shift+8.** Summons the main window from anywhere: brings the app to the foreground, selects the last-active pane. If the window is already focused, Cmd+Shift+8 is a no-op (not a toggle-hide, to avoid accidental dismissals mid-typing).

Conflict analysis (judgment call, not research-backed beyond standard macOS shortcut docs):

- macOS system-wide: Cmd+Shift+8 is not claimed by the system. The default zoom keyboard shortcut under Accessibility is Option+Cmd+8 (toggle) and Option+Cmd+Plus/Minus (zoom in/out). Cmd+Shift+8 does not collide.
- Common apps: Xcode uses Cmd+B for Build. Safari does not bind Cmd+Shift+8. Mail does not bind it. Notes does not bind it.
- Emoji picker (frequently used) is Control+Cmd+Space, different modifier set.
- Possible collision: apps that bind Cmd+8 to a specific tab (e.g. browsers binding Cmd+1 through Cmd+9 to tabs). Cmd+**Shift**+8 is Shift+8 = `*`, which browsers treat as "last tab" (Cmd+9 is last tab, actually, not Cmd+8). Low risk. Most browsers only intercept Cmd+N when focused, not globally.

Fallback: users can rebind from Settings > Appearance > Hotkey (Phase 2). v1 ships with a fixed shortcut registered via `MASShortcut` or the Carbon RegisterEventHotKey API.

Judgment call: **I am betting Cmd+Shift+8 is conflict-free for 8gent's target user.** If James's daily-driver apps (Xcode, VS Code, Figma, Notion) bind this differently, we rebind before ship. Needs one-pass real-machine test.

### 11.2 Notification badge strategy

- No macOS Dock badge (red pill with count) in v1. We do not run in the Dock (`LSUIElement = true`? answer in section 11.4). Judgment call: dock badges are loud and the menu-bar dot is enough.
- No macOS Notification Center alerts for routine events. Notifications are reserved for **user-consequential state changes the user is not looking at**: a session finishes its goal, a consent action times out, the daemon goes down while a session is running.
- Menu-bar dot handles "something is happening" (amber) and "something is wrong" (red). If the user has the main window closed and a session finishes, a small **+1 badge on the menu-bar icon** (a small "+1" next to the 8 glyph) appears. It clears on next main-window open.
- Notification sounds: off by default. Opt-in in Settings > Voice.
- ADHD mode: no badge, no sound, no notification. Just the steady menu-bar dot. This is non-negotiable.

### 11.3 Focus-stealing rules

Hard rule: the agent never brings the 8gent Computer app to the foreground on its own. Exceptions:

1. **Consent sheet for a user-initiated action.** The user just asked the agent to do X, X requires a new-bundle-id consent, the sheet attaches to the currently focused 8gent Computer window and *that* window is brought forward. If no 8gent Computer window is open, a minimal host window opens in the centre of the active display and the sheet attaches. This is the only focus-steal allowed.

2. **Daemon catastrophic failure while a session is running.** The menu-bar icon goes red. No window focus change. The user notices the icon or they open the app next time and see the banner.

3. **User-initiated wake.** Global hotkey, dock click, or `open -a`. Not a focus-steal by the agent.

Focus-steal audit log: every time the app pulls focus, a row is written to `~/.8gent/focus-log.json` with timestamp, reason, triggering session id. Visible in Settings > Daemon > Focus log (link-out, Phase 2 UI).

### 11.4 LSUIElement and Dock presence

**Locked 2026-04-24: LSUIElement = false.** The app shows in the Dock, and the status-bar item stays. Dock presence + menu-bar item + a free-floating compact window (section 11.6) are the three always-on surfaces when the main window is closed.

Users expect Cmd-Tab to include apps they have open. The menu-bar item is additive, not a replacement. The floating window is the "summoned" compact view; it coexists with the Dock icon and positions independently of both Dock and menu-bar.

This differs from Lil Eight (LSUIElement = true, menu-bar-only companion). 8gent Computer is a workspace.

### 11.5 Keyboard shortcut summary

| Shortcut          | Action                                              |
|-------------------|-----------------------------------------------------|
| Cmd+Shift+8       | Summon main window (global)                         |
| Cmd+N             | New session (in main window)                        |
| Cmd+W             | Close main window (app keeps running)               |
| Cmd+Q             | Quit                                                |
| Cmd+,             | Open Settings                                       |
| Cmd+F             | Find in current pane                                |
| Cmd+L             | Focus URL bar (browser tab only)                    |
| Cmd+R             | Reload (browser tab only)                           |
| Cmd+[  / Cmd+]    | Back / forward (browser tab only)                   |
| Cmd+1 ... Cmd+6   | Sidebar items: Sessions, Memory, Abilities, Schedule, Browser, Settings |
| Cmd+Return        | Open selected session in full pane                  |
| Cmd+Delete        | Forget selected memory                              |
| Esc               | Close sheet or popover                              |
| Cmd+D             | Deny (in consent sheet)                             |
| Cmd+Shift+A       | Allow once (in consent sheet, double-modifier)      |

### 11.6 Draggable floating window

**Locked 2026-04-24 (James).** When the main window is closed, 8gent Computer still shows a compact floating window so the user has a persistent visual handle on the agent beyond the menu-bar dot. The window is not dock-anchored, not menu-bar-anchored, not screen-edge-anchored. The user places it wherever they want and it stays there.

#### 11.6.1 Purpose

A glanceable surface: heartbeat, session count, quick-summon, theme and ADHD-mode toggles. It replaces the old "popover anchored to the status item" as the primary quick-glance surface. The status-item popover (section 4.2) remains for users who want a menu-bar-first flow, but the floating window is the canonical compact view.

#### 11.6.2 Layout

- Window type: `NSWindow` with `styleMask = [.borderless, .nonactivatingPanel]` subclass, floating level (`.floating` via `level = NSWindow.Level.floating`). Does not activate on click (agent status stays peripheral, does not steal focus).
- Size: 280pt wide x 180pt tall. Fixed in v1. Corner radius 14pt to match 8gentOS panel grammar.
- Content: top strip with the 8 glyph + heartbeat dot + "Daemon: {state}" text. Middle row "{n} sessions" with a small New session button. Bottom row: theme toggle (sun/moon icon), ADHD-mode toggle (label), Open main window button.
- Background: `--bg-1` with a 1pt `--border` hairline. Drop shadow: subtle, 8pt blur, 4pt y-offset, 12% opacity. Respects light/dark per section 3.5.

#### 11.6.3 Dragging

- Entire window body is a drag region (macOS pattern: override `mouseDownCanMoveWindow = true` on the root view). The user can grab anywhere that is not a button.
- No titlebar. The 8 glyph doubles as the visual "grab handle" for accessibility hint purposes only; dragging works from any background pixel.
- Cursor hint on hover over non-interactive area: `openHand` on enter, `closedHand` during drag.

#### 11.6.4 Bounds enforcement

- Minimum on-screen: **at least 50% of the window's rect must remain inside the visibleFrame of some display** at all times. Enforced on drag-end and on display-configuration change (`NSApplication.didChangeScreenParametersNotification`).
- If a drag would leave less than 50% visible, the window springs back to the nearest legal position on mouse-up (200ms ease-out, or instant in reduced-motion).
- Menu-bar safe zone: never allow the window's top edge to sit under the menu bar. The visibleFrame already accounts for this on macOS, so the 50% rule inherits it.
- Notch handling (MacBook Pro 14 / 16): `NSScreen.auxiliaryTopLeftArea` / `auxiliaryTopRightArea` are treated as unsafe; the window cannot overlap them.

#### 11.6.5 Snap-to-edge decision

**Decision: no edge-snapping.** The window drags freely and stays exactly where the user drops it. Sub-pixel `CGPoint` stored verbatim.

Reason: snap-to-edge is a BetterTouchTool / Rectangle mental model, not a macOS-native one. The only macOS-native floating-panel pattern (Finder-spring-loaded folders aside) that snaps is the Stage Manager strip, and users who use Stage Manager already have their own placement discipline. Adding snap in v1 introduces a second coordinate system (logical snap-zones vs actual pixels) that trips up multi-monitor and VoiceOver narration ("window moved to left edge" is less honest than "window at x=44").

If we ever add snapping it should be opt-in under Settings > Appearance > Floating window > "Snap to screen edges", default off.

#### 11.6.6 Persistence

- Key: `~/.8gent/config.json` under `app.floatingWindow`.
- Schema: `{ visible: bool, position: { displayId: string, x: number, y: number }[] }`. One position entry per display the user has placed it on; the app remembers per display.
- `displayId` is the `NSScreen.deviceDescription["NSScreenNumber"]` value (stable across launches on the same hardware, regenerated if the user plugs in different monitors).
- On launch:
  1. Read `app.floatingWindow`.
  2. For the currently active display (`NSScreen.main`), look up its entry. If found and the saved position passes the 50%-visible rule against the current visibleFrame, place there.
  3. If no entry for this display, default to bottom-right corner of the primary display, 24pt offset from the right and bottom visibleFrame edges.
  4. If the entry exists but the display is now unplugged, keep the entry in storage (do not purge) and use the fallback default for the current display.
- On every drag-end, update the entry for the current display only. The user moving the window on display A does not affect the memorised position for display B.

#### 11.6.7 Multi-monitor

- The window is always on one display at a time (the display containing its centre point).
- If the user drags across displays, the active-display entry updates to the new display at drop.
- Display hot-plug: `NSApplication.didChangeScreenParametersNotification` fires the 50%-visible rule on the current position; if the active display is gone, the window migrates to the new primary display's saved entry or the fallback default.

#### 11.6.8 Show/hide lifecycle

- The floating window is shown when: main window is not visible AND the app is running. It is hidden when: main window is visible, user dismisses via its close button, or user quits.
- Close button (a small "x" in the top-right of the floating window, shown on hover only so the chrome stays clean) hides the window for this session and sets `app.floatingWindow.visible = false`. To bring it back, the user uses the menu-bar item > Show floating window, or Settings > Appearance > Floating window > Visible.
- Global hotkey Cmd+Shift+8 opens the main window; it does not toggle the floating window.

#### 11.6.9 Accessibility

- Window `accessibilityRole = .window`, `accessibilitySubrole = .floatingWindow`, `accessibilityLabel = "8gent Computer floating window"`.
- Because the window is borderless, an explicit `accessibilityTitle = "8gent Computer"` is set.
- VoiceOver can focus the window via Cmd+F1 or VO+M and cycle its controls: heartbeat status, sessions count, New session, theme toggle, ADHD toggle, Open main window, Close.
- Dragging via keyboard: VO+Shift+drag is not supported natively on borderless windows. We add a menu command under Window > Move floating window > Top-left / Top-right / Bottom-left / Bottom-right / Centre, so keyboard-only users can reposition without a mouse. These four corner presets respect the 50% rule trivially (they are legal positions on any visibleFrame).
- `prefers-reduced-motion`: spring-back animation becomes instant. Drag itself is untouched (user input is not animation).
- ADHD mode: the heartbeat dot does not animate regardless of state. The window's drop-shadow is reduced to 4pt blur / 6% opacity to lower visual noise.
- Colour usage follows section 3.1. The theme and ADHD toggles render the same way they do in Settings.

#### 11.6.10 Copy notes

- "Daemon: OK" / "Daemon: reconnecting" / "Daemon: offline" (top strip)
- "{n} sessions" or "No sessions" (middle row)
- New session (button)
- Light / Dark (theme toggle label; icon sun/moon)
- ADHD mode (toggle label)
- Open main window (button)
- Close (button, tooltip "Hide floating window. Reopen from the menu bar.")
- Move floating window > Top-left / Top-right / Bottom-left / Bottom-right / Centre (Window menu submenu)

## 12. Open questions (James to decide)

**Resolved 2026-04-24:**

- ~~First-launch theme~~: **dark, inherited from 8gentOS** (see section 3.5).
- ~~LSUIElement~~: **false, Dock presence + floating window + menu bar** (see sections 11.4 and 11.6).
- ~~Floating surface placement~~: **draggable, not anchored, no snap-to-edge** (see section 11.6).

**Still open:**

1. **Global hotkey**. Cmd+Shift+8 proposed. Acceptable, or prefer Cmd+Shift+E (for "eight")? Cmd+Shift+E collides with Finder (Eject) when a volume is selected. Cmd+Shift+8 is safer.
2. **ADHD mode**. Any additional reductions I should bake in beyond motion, streaming, grids, and badges?
3. **Consent sheet default focus**. Proposed default = Deny. Acceptable, or should default = Allow once for friction-sensitive tasks?
4. **Browser theming**. Do we force a dark-mode hint on web pages (via CSS injection) when app is in dark, or let pages render their own theme? Proposed: let pages render their own.

## 13. Non-scope for this spec

- Visual mocks (Figma / sketches). This is text. Mocks come after spec sign-off.
- Copy localization. English only in v1, strings isolated.
- Onboarding / first-run tutorial. Deferred.
- Analytics / telemetry. No user-behaviour tracking in v1. Local-first Principle 2.
- Kernel UI, self-evolution UI (Phase 4+).
- Swift code. Zero Swift in this document.

## 14. Next steps (from this spec)

1. Merge this revision as the canonical v1.1 reference once James confirms no further changes on the four remaining open questions.
2. Stand up `packages/brand-tokens/` (section 3.5) and wire it into both the Next.js 8gentOS app and the Swift 8gent Computer project. Shared-tokens drift is now a P1 concern.
3. Pair with Karen on the consent sheet wording once the TCC entitlements table is final; the exact action names ("Screenshot", "Keyboard", "Mouse", "Clipboard read") should match her table.
4. Pair with Zara on copy strings in section 4.6 through 10.6 and the new 11.6.10 before Phase 1 code lands.
5. Once Rishi confirms Phase 1 scope = menubar + floating window, I scope the Phase 1 UX implementation notes as a child ticket.
6. No Swift code is written against this spec until the four remaining open questions are resolved.
