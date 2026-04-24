# 8gent Computer - Phase 1 Plan

Parent PRD: [#1746](https://github.com/8gi-foundation/8gent-code/issues/1746).
Related specs: `docs/prd/8gent-computer/architecture.md`, `security.md`, `ux-spec.md`, `brand.md`, `voice-ipc.md`.
Authored: 2026-04-24 - Rishi (8TO).
Branch: `docs/prd/8gent-computer-phase-1`.

This doc converts the PRD's one-line Phase 1 brief ("NSStatusBar item only, heartbeat, session count, Open Lil Eight") into a concrete ticket list with a dependency graph, acceptance criteria, and a risk register. No Swift code in this doc. No merge before James signs off on the sub-issue list.

---

## 1. Scope freeze

Phase 1 ships **v0 of 8gent Computer** - a signed, notarised, menubar-only macOS app that proves the daemon IPC path on a real user surface and establishes the security and brand primitives everything else will sit on.

**Shipped in Phase 1:**

1. A SwiftUI macOS app at `apps/8gent-computer/` with an Xcode project, a `build.sh`, and a minimum macOS target of 14.0.
2. One visible surface: an `NSStatusBar` item with an 8 glyph and a heartbeat dot (green / amber / red per `ux-spec.md` section 4.4).
3. Left-click on the status item opens a 320pt popover showing heartbeat text, active-session count, and two buttons: **Open Lil Eight**, **Pause all sessions**. Right-click opens a classic `NSMenu` with Open Lil Eight, Pause all, Open preferences (stub, links to repo docs in v0), About, Quit.
4. A WebSocket client that talks to the daemon at `ws://localhost:18789` using the protocol in `docs/specs/DAEMON-PROTOCOL.md`, with `channel: "computer"` on session scope. Pattern lifted from `apps/lil-eight/LilEight/main.swift:2185` (`class DaemonClient`). Reconnect with exponential backoff, heartbeat ping every 15 seconds.
5. A deep-link out to Lil Eight via `lileight://` (new URL type registered in `apps/lil-eight/LilEight/Info.plist`). Reciprocal `eightcomputer://` scheme registered on the 8gent Computer side, but v0 exposes only a single route (`eightcomputer://open`) for future use.
6. A global hotkey **Cmd+Shift+8** registered with `MASShortcut` or `RegisterEventHotKey`. In Phase 1 this fires a kill-switch **stub** that: (a) sends `sessions:pause-all` over the daemon WS, (b) logs a row to `~/.8gent/focus-log.json`, (c) flashes the menubar dot amber for 2 seconds. Full "revoke session tier for 60s" semantics per `security.md` section 7.2 is Phase 2.
7. A first-launch check that generates a per-install Ed25519 keypair, stores the private key in the login Keychain under service `com.8gent.computer.install-key` (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`), and registers the public key with `eight-vessel.fly.dev` via `POST /v1/installs/register`. This is the remote-wipe public key per `security.md` section 7.1. No AES-256 master key, no Qdrant volume, no encrypted sparse bundle in Phase 1 - those land with Phase 2's memory viewer.
8. A first-launch FileVault check. If off, a blocking help sheet: "Enable FileVault to install 8gent Computer" with a link to `https://support.apple.com/guide/mac-help/mh11785/mac`. No install continues until `fdesetup status` returns `FileVault is On.` per `security.md` section 7.3.
9. Brand tokens inherited from 8gentOS via a new `packages/brand-tokens/` package (JSON emitted from `BRAND.md`, consumed by the Swift app at build time and by 8gentOS at runtime). This is the draggable-window-and-beyond foundation even though the floating window itself is Phase 2. Tokens cover palette, typography, spacing, motion, heartbeat-status colours.
10. A build and notarisation path: `build.sh` produces a Developer-ID-signed, notarised DMG. Sparkle or equivalent update channel is **not** in Phase 1; updates are manual-download-only for v0.
11. End-to-end smoke test script at `apps/8gent-computer/scripts/smoke.sh`: fresh-install harness, TCC grant prompts, daemon online, menubar dot green, session count accurate, Open Lil Eight opens Lil Eight, Cmd+Shift+8 pauses sessions. Exit code 0 on pass.

**Not in Phase 1 (explicitly out):**

- Main window (Sessions / Memory / Abilities / Schedule / Browser / Settings panes). Phase 2.
- Consent sheet. Phase 2 (blocks computer-use).
- Memory viewer, Qdrant bundling, APFS encrypted sparse bundle. Phase 2.
- In-app browser (WKWebView). Phase 3.
- 8gent-hands (computer-use driver). Phase 3, pending cua-driver licence review.
- Voice IPC implementation (spec only exists). Phase 3.
- Settings pane beyond a stub menu item. Phase 2.
- Draggable floating window. Phase 2 (tokens land in Phase 1, window ships in Phase 2).
- Full kill-switch semantics (tier revocation, 60s cooldown). Phase 2.
- AES-256 master key, HKDF DEKs, per-collection encryption. Phase 2 (with memory store).
- Bundle-id screen-capture deny-list enforcement. Phase 3 (with hands).
- Mac App Store submission. v3+.
- Sparkle auto-update. Phase 2.
- Apple Sign-In, Clerk, any auth beyond the local Keychain install key. Phase 4 when the app contacts the vessel for anything beyond install registration.
- Shared Swift UI module extracted from Lil Eight. Phase 2 when the second consumer (Session cards) needs it.

---

## 2. Sub-task breakdown

Each row is one GitHub sub-issue under parent #1746. Size target: 1 to 3 days of real work. Order is by dependency; not strictly by ship order.

| # | Title | Size | Depends on |
|---|-------|------|------------|
| T1 | Scaffold Xcode project, bundle id, build.sh, min macOS 14 | 1d | - |
| T2 | Brand-tokens package (`packages/brand-tokens/`) emitting `tokens.json` from BRAND.md, consumed by both 8gentOS and Swift | 2d | - |
| T3 | Swift token loader + theme primitives (light/dark, accent, heartbeat colours) | 1d | T1, T2 |
| T4 | `DaemonClient.swift` WS client (reconnect, ping, `channel: "computer"`) ported from Lil Eight | 2d | T1 |
| T5 | Daemon-side `channel: "computer"` enum addition and `sessions:pause-all` handler (~30 lines across `packages/daemon/gateway.ts` and `agent-pool.ts`) | 1d | - |
| T6 | NSStatusBar item, 8 glyph (template image), heartbeat dot view, state machine (ok/warn/bad/first-launch) | 2d | T3, T4 |
| T7 | Popover view: heartbeat summary, session count, Open Lil Eight button, Pause all button; right-click NSMenu | 2d | T6 |
| T8 | Active-session-count query over WS (`sessions:list`), live subscription, badge on menubar icon on +1 completion | 2d | T4, T6 |
| T9 | Deep-link out: `lileight://` URL type on Lil Eight side, Swift `NSWorkspace.shared.open` on 8gent Computer side | 1d | T1 |
| T10 | Cmd+Shift+8 global hotkey, kill-switch stub (pause-all + focus-log + 2s amber flash) | 2d | T4, T5, T6 |
| T11 | First-launch Keychain Ed25519 keypair, `POST /v1/installs/register` to `eight-vessel.fly.dev` | 2d | T1 |
| T12 | First-launch FileVault check (`fdesetup status`), blocking help sheet if off | 1d | T1 |
| T13 | `build.sh` full path: archive, Developer ID sign, notarytool staple, create-dmg | 2d | T1, T6, T7, T8, T9, T10, T11, T12 |
| T14 | Smoke-test script at `apps/8gent-computer/scripts/smoke.sh` covering install, TCC, daemon, menubar, Open Lil Eight, Cmd+Shift+8 | 1d | T13 |

Fourteen sub-issues. Under the 15 cap.

**Changes from the task list James sketched:**

- **Kept** all twelve items from the sketch.
- **Renamed** "draggable-window positioning" to the brand-tokens package (T2, T3). The token package is the real prerequisite for a future draggable surface. Phase 1 itself ships zero draggable code, because the floating window is not in Phase 1. Building draggable-stub code that does not render is the kind of speculative layer the No-BS rules forbid.
- **Split** "Implement daemon WebSocket client" from the daemon-side enum change. Client is T4, daemon patch is T5. Different owners, different repos paths, different review lenses.
- **Merged** "Installer / notarisation groundwork" with the full build path in T13. One ticket, one owner, one completion criterion.

---

## 3. Dependency DAG

```
T1 (Xcode scaffold) ----+---+---+---+---+---+
                        |   |   |   |   |   |
T2 (brand-tokens) --> T3 (Swift theme) --> T6 (status bar) --> T7 (popover)
                                            |                   |
T5 (daemon enum) --> T4 (DaemonClient) -----+                   |
                        |                   |                   |
                        +---> T8 (session count) ---------------+
                        |                   |
                        +---> T10 (hotkey) <+
                                            |
T11 (keychain+register) ---> T13 (build/notarise) <--- T7, T8, T9, T10
T12 (FileVault)         ---> T13
T9  (deep-link)         ---> T13

T13 --> T14 (smoke test)
```

**Critical path: T1 -> T4 -> T6 -> T7 -> T8 -> T13 -> T14.** Everything else runs in parallel tracks.

---

## 4. Acceptance criteria for Phase 1 ship

Phase 1 is done when **all** of the following are true on a fresh macOS 14+ machine with FileVault on, Developer ID trusted, and 8gent Code daemon running:

1. DMG installs. App shows in `/Applications/`, bundle id `com.8gent.computer`.
2. First launch: FileVault check passes, Keychain keypair generated, public key registered with the vessel (verifiable by `curl https://eight-vessel.fly.dev/v1/installs/<id>` returning 200 with the same public key).
3. Menubar 8 glyph appears. Heartbeat dot is green with daemon online, red with daemon offline, amber while reconnecting. State transitions live within 3 seconds of the daemon going up or down.
4. Left click on status item shows popover. Popover shows live session count (`"N sessions running"` when N > 0, `"No active sessions"` when N == 0). Changes reflect within 2 seconds of a session starting or ending.
5. Right click shows `NSMenu` with Open Lil Eight, Pause all sessions, Open preferences, About, Quit.
6. Clicking Open Lil Eight launches Lil Eight if installed. If not installed, a plain sheet: "Lil Eight is not installed. Install it from 8gent.dev." No crash.
7. Cmd+Shift+8 global hotkey fires from any foreground app. Sends `sessions:pause-all`. Menubar dot flashes amber for 2 seconds. Row written to `~/.8gent/focus-log.json` with timestamp, reason, origin app bundle id.
8. App survives daemon restart: WS reconnects, dot returns to green, no crash.
9. Brand tokens match 8gentOS: visual QA on dot colours, accent, typography against `BRAND.md` palette. Zero banned hues (270-350). Zero em dashes in menubar copy.
10. Smoke test exits 0. CI runs the smoke test headlessly on every PR touching `apps/8gent-computer/`.
11. Zero references to AI vendors in user-facing copy. Grep for `Claude`, `Anthropic`, `OpenAI`, `GPT`, `Gemini`, `Codex`, `ChatGPT` across the Swift source and the DMG strings. Zero hits.
12. Notarisation staple passes. `xcrun stapler validate` returns green.

---

## 5. Risk register

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **TCC prompts surface too early and scare the user** | Medium | Medium | Phase 1 only triggers Accessibility and Screen Recording if the user actively uses the kill-switch (it needs neither for the pause-all path). Otherwise no TCC prompts in Phase 1. Microphone prompt only fires in Phase 3 when voice ships. |
| **Developer ID cert missing or expired** | Medium | High | Pre-flight check before T13 starts. Karen's ticket on the security spec already assumes Developer ID exists; James confirms on or before 2026-04-27 or T13 slips. |
| **Notarisation rejects the DMG** | Medium | High | First notarisation attempt before T14. If rejected, iterate on entitlements and hardened runtime settings. `security.md` § 3.1 table is the baseline. |
| **Daemon protocol drift** | Low | Medium | Lock the client to the spec at `docs/specs/DAEMON-PROTOCOL.md` commit SHA at T4 start. If daemon changes the contract mid-Phase-1, that is a coordinated PR and not a surprise. |
| **Cmd+Shift+8 conflicts with a user app** | Low | Low | UX spec section 11.1 already audited the shortcut. If a collision surfaces in smoke testing, fall back to user-configurable in Phase 2. Phase 1 ships the fixed combo. |
| **FileVault blocker feels hostile** | Medium | Low | Help-sheet copy (Zara's track) explains the one reason in plain English: "Your work on this machine deserves encryption." Ship-level copy lands in Phase 1 review. |
| **Brand-tokens package adds cross-repo coupling** | Low | Medium | The package lives in this repo. 8gentOS pulls it as a git submodule or npm dep only when 8gentOS is ready. Phase 1 only commits the package and Swift loader; 8gentOS adoption is a separate PR in the OS repo. |
| **`eight-vessel.fly.dev /v1/installs/register` endpoint does not exist yet** | High | Medium | T11 includes a vessel-side PR to add the endpoint (roughly 50 lines of TypeScript). Track as part of T11's acceptance. |
| **Users on Intel Macs in early pilot** | Medium | Medium | `build.sh` produces a universal binary (`arm64` + `x86_64`). One more flag. Negligible cost. Smoke test runs on one arm64 Mac in Phase 1; an Intel pass is a Phase 2 nice-to-have. |
| **Lil Eight URL scheme registration breaks Lil Eight's own launch path** | Low | Low | T9 is a 3-line `Info.plist` edit with no runtime behaviour change in Lil Eight unless the URL is opened. Smoke-test Lil Eight boots clean after the edit. |

---

## 6. Estimated total Phase 1 duration

**Ideal-world engineering effort: 19 developer-days** (sum of the sub-issue sizes).

**Real-world calendar estimate: 3.5 to 4.5 weeks.**

Reasoning:

- Two parallel tracks (critical path + brand-tokens/security track) give a critical-path floor of roughly 12 days of engineering if everything stacks cleanly.
- Notarisation has a first-time-ever tax: Apple's notary queue, entitlements iteration, cert wrangling. Budget 3 extra days for T13.
- Review loops: each PR gets a review pass. With Karen on security and Moira on UX review, add 0.5 day per PR across roughly 8 reviewable PRs = 4 days.
- James's decisions (FileVault blocker tone, hotkey, install-key custody) are pre-locked, but a few small calls will land mid-build. Budget 1 day of waiting per week.
- I am reporting the honest calendar number. The PRD said "~1 week" and that is optimistic for anything that crosses the "signed, notarised, installed on a clean Mac" line. A menubar prototype is one week. A shippable menubar product is a month.

No single-week schedule will produce this without cutting notarisation, FileVault gating, install-key registration, or brand-tokens. Each of those is a Phase 1 foundation we will pay back tenfold to skip. Recommend James accept the 3.5 to 4.5 week window, or reduce Phase 1 scope explicitly by dropping one of: brand-tokens (push to Phase 2), install-key registration (push to Phase 2), FileVault blocker (push to Phase 2 with a warning-only posture).

My recommendation: ship the full Phase 1 as scoped. The foundations multiply.

---

## 7. Next steps

1. Merge this plan doc via PR.
2. File the fourteen sub-issues against parent #1746 with the `infrastructure` label and size in the title (e.g. `[1d]`, `[2d]`).
3. James accepts the calendar estimate or explicitly reduces scope.
4. Assign owners: Swift work is unassigned until the engineering track picks up (James himself or a contractor). Brand-tokens T2 can start in parallel with any frontend hand on it.
5. T1 begins only after the parent PRD #1746 and this plan are both at "approved" on the project board.
