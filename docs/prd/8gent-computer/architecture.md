# 8gent Computer - Architecture Spike

Companion doc to PRD [#1746](https://github.com/8gi-foundation/8gent-code/issues/1746). This is a spike, not a spec. Goal: surface enough technical detail that Karen, Moira, and Zara can work their tracks in parallel while James decides the open questions at the bottom.

Authored: 2026-04-24 - Rishi (8TO)
Branch: `docs/prd/8gent-computer-architecture`

---

## 1. Scope check

**What this doc decides:** Swift app shape, IPC surface, package reuse map, build shell.
**What this doc defers:** TCC entitlements table (Karen), UX flows (Moira), launch copy (Zara), 8gent-hands fork internals (separate spike once cua-driver license review lands).

**Blast radius (estimate):** New directory `apps/8gent-computer/`. Extensions to `packages/daemon/gateway.ts` (one new channel enum value, roughly 5 lines) and `packages/computer/bridge.ts` (thin policy-pass-through, roughly 30 lines). Two Info.plist files edited (this app plus `apps/lil-eight/LilEight/Info.plist` to add a reciprocal URL scheme). No changes to `packages/memory/`, `packages/voice/`, `packages/orchestration/` in v1. Touching fewer than 5 files outside `apps/8gent-computer/` itself.

---

## 2. Swift app structure

SwiftUI, min macOS 14.0 (matches Lil Eight). Apple Silicon first, Intel later.

```
apps/8gent-computer/
  build.sh                             # parity with apps/lil-eight/build.sh
  8gentComputer.xcodeproj/             # generated, not checked in
  8gentComputer/
    Info.plist                         # LSUIElement=false, URL scheme eightcomputer://
    8gentComputerApp.swift             # @main, AppDelegate, NSStatusBar wiring
    App/
      AppDelegate.swift                # NSStatusBar item + URL event handler
      DeepLinkRouter.swift             # routes eightcomputer:// URLs to views
    Views/
      MenuBar/
        StatusBarController.swift      # NSStatusItem + popover
        HeartbeatView.swift            # green/amber/red dot bound to daemon state
        MenuDropdown.swift             # Open window, Sessions, Pause all, Kill
      MainWindow/
        MainWindow.swift               # NSWindow + split view
        SidebarView.swift              # Sessions/Memory/Abilities/Schedule/Ethics/Settings
        SessionPane.swift              # active session transcript + tools trail
      ConsentSheet/
        ConsentSheetView.swift         # per-action approval modal
        PolicyRulesView.swift          # remembered per-bundle-id rules list
      MemoryViewer/
        MemoryBrowser.swift            # Qdrant collection + SQLite FTS5 search
        ForgetControls.swift           # one-click delete, tier filter
      SessionManager/
        ParallelAgentGrid.swift        # up to 10 sessions (packages/daemon/agent-pool)
        SessionCard.swift              # embeds Lil Eight card view via shared module
      BrowserTab/
        BrowserTabView.swift           # WKWebView host + AX tree piping
      Settings/
        EthicsToggles.swift
        AppDenyList.swift              # bundle-id blocklist editor
        VoiceConfig.swift
    Services/
      DaemonIPC.swift                  # WebSocket client (pattern lifted from lil-eight)
      PolicyBridge.swift               # calls packages/permissions policy-engine over IPC
      MemoryService.swift              # read-only views into memory + Qdrant
      HandsService.swift               # invokes cua-driver binary, later 8gent-hands
      QdrantClient.swift               # 127.0.0.1:6333 HTTP client
    Resources/
      Assets.xcassets/
```

Estimate: roughly 2,500 lines of Swift for Phase 2 (main window + consent + memory viewer). Phase 1 (menubar only) is under 400 lines.

### Shared Swift module (deferred)

Lil Eight's `main.swift` is a 3,768-line single file. The pet card renderer (lines 1243-1398) is the code we want to reuse for `SessionCard.swift`. **Do not extract yet.** The clean move is:

1. Phase 1 ships with 8gent Computer menubar only, no card rendering - no dependency on lil-eight code.
2. Phase 2 introduces a third target `apps/shared-ui/` (Swift Package) that both apps import. Refactor happens in a separate PR owned by whoever touches Lil Eight next.
3. If we try to share code in Phase 1 we burn a week on build-system plumbing. Skip.

---

## 3. Daemon IPC

### Correction to PRD

PRD section "Data plane" says daemon socket is `/tmp/8gent-daemon.sock`. That is wrong. Today's daemon is a WebSocket server at `ws://localhost:18789`, per `docs/specs/DAEMON-PROTOCOL.md` line 12. Lil Eight uses exactly this (see `apps/lil-eight/LilEight/main.swift:2185-2264`, class `DaemonClient`). 8gent Computer reuses the same protocol.

No Unix socket. No new IPC layer. Protocol is already defined, already shipping, already talking to Lil Eight.

### Reuse vs extend

**Reuse as-is (no daemon code changes):**
- `type: auth` handshake
- `type: session:create`, `session:resume`, `session:destroy`, `sessions:list`
- `type: prompt` with streaming `event: agent:stream`, `tool:start`, `tool:result`
- `type: health`, `ping`, `pong`
- `type: cron:list`, `cron:add`, `cron:remove`

**Extend (5-line diffs in `packages/daemon/gateway.ts`):**
- Add `"computer"` to the `channel` string-union where it is defined. Grep for `channel: "os" | "app" | "telegram"` and append. This is a two-token change.
- Add `type: policy:list` and `type: policy:set` messages so the consent sheet can read and edit NemoClaw rules without the app importing TS code. Backend delegates to `packages/permissions/policy-engine.ts` which already exists.

**New messages (drafted here, implement in Phase 2):**
```
Client -> { "type": "memory:search", "query": "...", "collection": "session_memory", "limit": 20 }
Server -> { "type": "memory:results", "hits": [...] }

Client -> { "type": "memory:forget", "ids": [...] }
Server -> { "type": "memory:forgot", "count": N }

Client -> { "type": "policy:list" }
Server -> { "type": "policy:list", "rules": [...] }

Client -> { "type": "policy:set", "bundleId": "com.apple.Safari", "action": "screenshot", "verdict": "allow" }
Server -> { "type": "policy:set:ok" }
```

Total daemon-side code to add: roughly 120 lines across `gateway.ts` and two new handlers. No new dependencies.

### Auth token

Daemon already supports optional `authToken` from `~/.8gent/config.json`. 8gent Computer reads the same file (it is a shared user dir, per PRD) and sends the auth handshake. No new secret surface.

---

## 4. Deep-link URL scheme

Two apps, two schemes, reciprocal:

| Scheme            | App             | Example                                              |
|-------------------|-----------------|------------------------------------------------------|
| `eightcomputer://` | 8gent Computer  | `eightcomputer://session/s_abc123` (open session)    |
| `lileight://`      | Lil Eight       | `lileight://companion/c_xyz789` (open pet card)      |

Both apps register their scheme in `Info.plist` under `CFBundleURLTypes`. Lil Eight's `Info.plist` does NOT currently have a URL type (confirmed against file contents). This becomes a one-stanza edit on the Lil Eight side in Phase 2.

Flow: user clicks a pet card in the Lil Eight deck UI, the card has an NSClickGestureRecognizer that calls `NSWorkspace.shared.open(URL(string: "eightcomputer://session/\(sessionId)")!)`. macOS routes the URL to the registered handler app. `DeepLinkRouter.swift` in 8gent Computer parses and opens the corresponding `SessionPane`.

Open question (in Open Questions below): URL scheme or AppleEvent. **Recommendation: URL scheme.** It is one plist key per app, inspectable in `defaults read`, works from any source including Terminal (`open eightcomputer://...`). AppleEvents need entitlements and a handler registry. Not worth the cost for this use case.

---

## 5. Package reuse map

Every capability on the PRD feature-scope table, mapped to whether the Swift app **calls** an existing package over IPC, **reimplements** in Swift, or **depends on something that does not yet exist**.

| PRD capability           | Existing package              | Swift strategy           | Status                    |
|--------------------------|-------------------------------|--------------------------|---------------------------|
| Daemon heartbeat         | `packages/daemon/heartbeat.ts`| call over WS `type:health`| Exists                    |
| Parallel agents          | `packages/daemon/agent-pool.ts` (10 max) | call over WS `sessions:list` + `session:create` | Exists |
| Memory viewer (SQLite)   | `packages/memory/` (SQLite+FTS5) | new WS msg `memory:search` | Needs handler (roughly 60 lines) |
| Memory viewer (Qdrant)   | **DOES NOT EXIST YET**        | Swift calls Qdrant HTTP 127.0.0.1:6333 directly | Qdrant container wiring missing |
| Voice I/O                | `packages/voice/` (KittenTTS)  | call over WS (new `voice:speak` msg) OR shell out to local bin | Package exists, IPC path does not |
| Schedule / wake-ups      | `packages/cron/`, `packages/proactive/` | call over WS `cron:*` (exists) | Exists |
| Computer-use (hands)     | `packages/computer/bridge.ts` wraps `usecomputer` npm + `cua-driver` binary at `/usr/local/bin/cua-driver` | Swift spawns `cua-driver` directly for local snappiness, daemon for policy check | Bridge exists, `packages/hands/` fork does not |
| In-app browser           | `packages/tools/browser/` is **HTTP fetch only** (fetch-page, web-search). NOT a web-view. | Swift uses WKWebView directly, plus AX tree read | WKWebView is native, no package dep. Fine. |
| Image generation         | `packages/providers/`          | call over WS `prompt` with image-gen tool selected by agent | Exists |
| Policy engine (NemoClaw) | `packages/permissions/policy-engine.ts` | call over WS `policy:list`/`policy:set` | Handler missing (roughly 40 lines) |
| Vessel mesh / orchestration | `packages/orchestration/agent-pool`, `vessel-mesh` | call over WS `sessions:list` | Exists |
| Session deck             | Lil Eight (`apps/lil-eight/`) | deep-link via `lileight://` | Needs URL type in Info.plist |

### Honest gaps

1. **Qdrant is not wired anywhere in the current repo.** PRD assumes a local Docker container at `127.0.0.1:6333`. No `docker-compose.yml`, no health check, no mock. Karen's security ticket must cover "how Qdrant gets installed on the user's machine" - docker desktop dependency is a non-trivial user-onboarding tax.
2. **`packages/hands/`** does not exist. PRD footnotes this as planned fork of `trycua/cua`. For v1 phase 2, 8gent Computer shells out directly to `/usr/local/bin/cua-driver` with a policy check wrapped around each invocation. That is the smallest thing that works until the fork is stood up.
3. **Voice IPC path is not defined.** `packages/voice/` exists as a library, but there is no WebSocket message for "speak this string" today. Either we add one (small addition) or Swift shells out to a local KittenTTS binary. Defer until Phase 3.
4. **`packages/tools/browser/` is HTTP-level.** WKWebView is the Swift-native answer. No package gap - this is just a doc correction on the PRD which implies the package is web-view-capable.
5. **`packages/proactive/`** exists as revenue-engine / outreach modules, not routines scheduling. The scheduling piece is `packages/cron/routines.ts`. PRD phrasing was imprecise; the UI surface (Schedule pane) binds to cron, not proactive.

None of these gaps block Phase 1. All become concrete tickets before Phase 2.

---

## 6. Build and signing

### Phase 1 (developer only)

`xcodebuild` local, unsigned, run from disk. Same as Lil Eight today.

### Phase 2+ (distribute to James + pilot users)

Two paths, pick one:

**Path A: Notarised DMG (direct download from 8gent.dev)**
- Developer ID Application certificate (already needed for Lil Eight distribution - confirm with Karen if this exists on James's account today).
- `xcodebuild archive` -> `xcrun notarytool` -> DMG packaged via `create-dmg`.
- Works with `hdiutil` in CI, no MAS review cycle.
- TCC permissions (Accessibility, Screen Recording) stay user-managed, standard consent dialogs.
- Updates via Sparkle framework or similar.
- **Pro:** No MAS gatekeeping. Ship when we want. Full screen-recording entitlement uncontroversial.
- **Con:** We own the update channel. One more thing to operate.

**Path B: Mac App Store**
- Same Developer ID plus MAS distribution profile.
- TCC permissions via entitlement request; screen recording needs explicit justification in review.
- Sandbox requirements make spawning `cua-driver` as a child process painful - sandboxed apps cannot invoke arbitrary binaries without workarounds.
- **Pro:** Built-in updates, trust signal, billing later if we ever sell tiers.
- **Con:** Sandbox blocks computer-use as currently architected. Full rewrite of HandsService to use XPC or a helper app. Weeks of work.

**Recommendation not decided here.** Flag for James. My read: Path A for v1, evaluate Path B when we are ready to charge, and only if the sandbox cost becomes smaller than the ongoing DMG-hosting cost. Moira and Zara's tracks do not depend on this decision. Karen's does - the TCC story is very different in a sandboxed app, so we need a call before her ticket is closable.

---

## 7. Open questions (James to decide)

Numbered to match PRD's open questions section, plus added ones from this spike:

1. **MAS bundle vs notarised DMG for v1.** See Section 6. Leaning Path A.
2. **Auth: Clerk (matches 8gent-OS) vs Apple Sign-In only.** Spike-out: Apple Sign-In is ~20 lines of SwiftUI, Clerk requires a web redirect loop in a native app. For v1 menubar that only talks to a local daemon, auth may not be needed at all - the daemon is localhost-only. Recommend deferring auth until the app calls `eight-vessel.fly.dev` for anything, which Phase 1-3 does not.
3. **In-app browser: sandboxed cookie store vs shared Safari session.** Shared Safari requires `com.apple.security.cs.allow-jit` and a much harder TCC story. Recommend sandboxed WKWebView in v1, surface as a setting in v2.
4. **Deep-link: URL scheme vs AppleEvent.** See Section 4. Recommend URL scheme.
5. **Naming in code vs copy.** Confirm: `apps/8gent-computer/` (kebab-case, file paths), bundle id `com.8gent.computer`, user-visible string "8gent Computer" (proper noun, two caps). Zara's ticket locks the launch spelling.
6. **(New) Qdrant onboarding UX.** Docker Desktop is a 800 MB install. How does a non-technical user install it? Options: (a) bundle a Qdrant binary, (b) require Docker Desktop, (c) fall back to SQLite-only memory in v1 and defer Qdrant to v2. Karen's ticket.
7. **(New) Shared pet card rendering.** Lil Eight's pet card is a 150-line SwiftUI block inside a 3,768-line Swift file. Phase 2 needs this in the Session Manager grid. Decision: refactor Lil Eight into a Swift Package in a separate PR, OR duplicate the render code. Recommend: duplicate for v1 (roughly 150 lines), refactor in v2 when there is a third consumer.

---

## 8. Explicit non-scope for this spike

- TCC entitlement table (owned by Karen)
- Visual / UX (owned by Moira)
- Brand positioning / tagline (owned by Zara)
- 8gent-hands fork internals (separate spike, post-license-review)
- Kernel / RL fine-tuning (`packages/kernel/`) - off by default, irrelevant to Phase 1-3
- Self-evolution UI (`packages/self-autonomy/`) - Phase 4+

---

## 9. Next steps (from this spike)

1. Merge this architecture doc as a reference (PR open, do not merge tonight).
2. File sub-issues for Karen (security), Moira (UX), Zara (brand). Each child of #1746.
3. James answers the 7 open questions.
4. After Samantha's abilities deck lands and James's answers land, I scope Phase 1 as a separate ticket with a file-by-file plan.
5. No Swift code is written until steps 1-4 are done.
