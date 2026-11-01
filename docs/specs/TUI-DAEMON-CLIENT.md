# TUI as a Daemon Client: One Session, Many Surfaces

Status: DESIGN, DECIDED 23 Oct 2026 (section 1.1). Build plan in section 6. Owner: 8TO Rishi. Security review: 8SO Karen.
Written 23 Oct 2026 against `origin/main` at `0b8a6f456` (#4790). Refreshed 25 Oct 2026 against `origin/main` at `9d08c8763` (package.json 0.20.29, the v0.20.29 tag plus 15 later commits): slices 1 and 2 are built, slice 3 is not, and every file and line reference below was re-checked against that commit.
Tracking issue: #4792.

## 1. Frame

**Problem.** A person who opens the 8gent-code TUI and then messages their bot on
Telegram is talking to two different 8gents, with two memories and two approval
models, so nothing they do on one surface is visible on the other.

**Constraint.** Safety first, then size. No surface may gain authority by being
linked to another: a Telegram tap must never allow what the TUI's own policy
would refuse, and a loopback socket must never become a way into the operator's
session for another local user or a web page.

**Not doing.**
- No new transport. The daemon WebSocket protocol (`docs/specs/DAEMON-PROTOCOL.md`)
  and the TUI client that already speaks it (`apps/tui/src/lib/daemon-sessions.ts`)
  are the transport.
- No merge of the TUI's local memory store with the daemon's. A linked session
  uses the daemon's memory, full stop. Reconciling two stores is a separate issue.
- No remote (non-loopback) TUI. Fly.io and phone relay stay as they are.
- No prompt access for non-operator Telegram senders in this work. The prompt
  tier stays refused until it gets its own deny-by-default session (section 5.4).
- No yolo across surfaces. `yolo.json` stays TUI-only and in-process-only.
- No change to Discord, Table, classroom, computer or dispatch channels.

**Success metric.** Three checks, each an automated test plus one recorded live run:
1. A message typed in a TUI tab and a message sent to the bot on Telegram land
   in the same session transcript, in order, and each surface shows the other's
   message labelled with its source.
2. One gated command raises a card on both the TUI and Telegram; answering on
   either resolves the request exactly once, the other card closes as
   "answered elsewhere", and the audit log has one decision line.
3. A Telegram "allow in this chat" never auto-approves a TUI-started turn, and a
   command the TUI policy blocks is never offered on Telegram.

### 1.1 Decided

James decided in the 8gi group on 23 Oct 2026 at 18:26 (msgs 8408 and 8411), answering "1 yes auto attach" to the options on this design:

1. **Auto-attach: yes.** The TUI becomes a daemon client (epic #4792). When the
   daemon is running, the TUI attaches to it on its own, with no command. This
   answers open question 1 (attach on launch by default).
2. **Approvals from the TUI, same one-yes gate.** From the TUI a person can approve
   actions in turns that started on Telegram, using the same one-yes gate. This
   answers open question 2 (the TUI may answer cards raised by Telegram turns).

What "same one-yes gate" means here: one card, one answer, once. The first answer
from any surface settles it (section 4.4, "Once"), the TUI draws the card with the
card UI it already has, and the permission rules are unchanged: always-blocked is
never offered, must-ask stays refused, and `yolo.json` is never read across the link.
Nothing in the decision widens what a surface may approve.

Still open: questions 3 and 4 in section 7. Their defaults (TUI turns are never
posted to Telegram; token by default lands in slice 3) stand until James says otherwise.

## 2. What exists today

### Already built (do not rebuild)

| Piece | Where | What it does |
|---|---|---|
| TUI daemon client | `apps/tui/src/lib/daemon-sessions.ts` `DaemonSessionClient` (connect, list, attach, detach, abort, prompt, onEvent) | #3929. The TUI can already join a daemon session over loopback and render its events (`toChatEvent`). |
| TUI wiring | `apps/tui/src/app.tsx` `linkDaemonSession` (line 3109), `/sessions` handler (`case "sessions"`, line 5065), `EIGHT_TUI_SHARE=1` auto-share | Attach through `/sessions`, `/sessions attach home` for the Telegram tab (#4838), or auto-attach (below). On attach the chat is replaced by the daemon transcript. |
| Shared session verbs | `packages/daemon/shared-sessions.ts` `handleSharedSession`, `handleResume`, `SHAREABLE_CHANNELS` (line 25) | list/attach/detach/abort, loopback-only, transcript capped (200 messages, 20k chars). |
| Echo across clients | `packages/daemon/gateway.ts` `echoPrompt` (line 292) | A prompt from one socket is shown to every other authenticated socket on the same session as `user:message` with its channel. |
| Channel approvals | `packages/daemon/channel-approvals.ts` `ChannelApprovals.request/respond/settle`, `withChannelApprovals` | #3621. A gated shell command in a bridge-started turn waits for a Telegram tap. `settle` deletes the pending entry first, so a second answer is already a no-op (`not-live`). |
| Approver scope | `packages/permissions/index.ts` `runWithChannelApprover` (line 94), headless branch of `promptUser` (line 1227) | AsyncLocalStorage per turn. Always-blocked commands are never offered; must-ask commands are refused headless (#3748). |
| Approval routing in gateway | `gateway.ts` `approvals:register` (line 813), `approval:response` (line 821), `prompt` (line 667) | Only a socket holding the bridge secret may answer, and only a bridge socket's `turn` binds an approver. |
| Telegram tiers | `packages/daemon/telegram-bridge.ts` `senderTier` (line 721), `isCommandAllowed` (line 758) | full / prompt / observe. Prompts are full-tier only. |
| Bridge session | `telegram-bridge.ts` `TelegramDaemonBridge.connectDaemon` (line 1227), `freshSession` (line 1213) | One `telegram` channel session per bridge, resumed on reconnect. |
| Journal and resume | `packages/daemon/session-journal.ts` `resumeJournaledSessions`, `continueInterruptedTurns` | #4082. A turn in flight survives a daemon restart. |
| Pool | `AgentPool` in `packages/daemon/` (`MAX_SESSIONS = 10` line 95, `NEVER_EVICT` line 158, `createSession` overrides incl. `workingDirectory`) | Tools run daemon-side in the session's working directory. |
| Origin and Host guard | `packages/daemon/origin-guard.ts` `guardRequest`, `assertSafeBind` | Refuses foreign Origin (cross-site WebSocket) and foreign Host (DNS rebinding); refuses a non-loopback bind without a token. |
| Service install | `packages/daemon/service.ts` (launchd on darwin, systemd --user on linux, Scheduled Task on win32, termux-services on android since #4878) | `8gent daemon` subcommand (`bin/8gent.ts` line 604). |
| Own bot setup | `apps/tui/src/lib/telegram-setup.ts` (#4594) | Writes bot settings for a second, in-process bridge. Not shared. |
| Yolo | `packages/permissions/yolo-pref.ts` (#4790) | "Only the TUI reads this. Headless -p and the daemon never do." |
| TUI auto-attach (slice 1) | `apps/tui/src/lib/daemon-autoattach.ts` `autoAttachMode`, `autoAttachAllowed`, `daemonHealthUrl`, `probeDaemon`; `app.tsx` probe effect (line 3253); `StatusFooter.tsx` `daemonAttached` chip (line 212) | #4829, #4830. Opt in with `EIGHT_TUI_DAEMON=auto`, loopback only, a daemon that proves its identity first (`identify`), a footer chip while linked. Off by default until slice 3 (approvals). |
| Telegram home session (slice 2) | `gateway.ts` `home:declare` (line 800), `shared-sessions.ts` `HOME_ALIAS` (line 181) and the operator rule (line 269), `packages/daemon/local-link.ts` (token and discovery files), `DAEMON_CAPABILITIES` `turn-origin` (`input-gate.ts` line 33), `daemon-sessions.ts` discovery (line 174) | #4834, #4838. `/sessions attach home` opens a Telegram tab; the bridge posts only events tagged with Telegram as their origin. |

### Missing (the actual gap)

Seven gaps were listed when this was written on 23 Oct. As of `9d08c8763` five are
closed and two are open; the open ones are first.

**Still open**

1. **The TUI does not attach by default.** Auto-attach is built (#4829, #4830,
   `daemon-autoattach.ts`) but is opt-in through `EIGHT_TUI_DAEMON=auto` and becomes
   the default only when slice 3 (approvals) lands, because a daemon-run TUI turn
   refuses every command that needs a card. Without the variable the TUI is the
   standalone process it always was.
2. **No interactive approvals for a TUI turn inside the daemon.** A TUI socket
   is not the bridge, so its `prompt` binds no approver; a command that needs a
   yes is refused (`permissions/index.ts` line 1236, `_noCardSurface`, #4829; the
   older headless refusal is at line 1261), and the
   `DaemonChatEvent` union has no approval kind, so the TUI could not draw a card
   anyway. This is slice 3.

**Closed since 23 Oct**

3. Telegram sessions could not be attached. Built in slice 2 (#4838): the
   `home` alias, attach only for a loopback socket that proved the operator token
   (`shared-sessions.ts` line 272 still keeps `telegram` out of
   `SHAREABLE_CHANNELS`, line 25, so it is never listed or attached by id).
4. The TUI found the wrong daemon. Slice 2 discovery reads `daemon.json` from
   `~/.8gent` and `~/.8gent/*/daemon.json`, ignores dead pids and takes the token from
   the discovered directory (`daemon-sessions.ts` line 174). The daemon itself
   reads `${DATA_DIR}/config.json` (`packages/daemon/index.ts` line 73).
5. The bridge would post TUI turns to Telegram. The bridge now posts only events
   whose origin is Telegram (`gateway.ts` line 311, the `turn-origin` capability);
   the destination chat is still `replyChat()` (`telegram-bridge.ts` line 1560).
6. No token by default. The daemon creates `<dataDir>/daemon.token` (0600) on first
   start (`index.ts` line 385). It gates the home session and proves the daemon's
   identity; gating the whole gateway is still opt-in with `EIGHT_DAEMON_REQUIRE_TOKEN=1`
   (open question 4).
7. Termux had no service backend. `service.ts` has an `android` platform since #4878
   (termux-services, runit); see 4.7 for how that differs from the Termux:Boot design.

## 3. Options

| | A. TUI attaches to the running daemon, falls back in-process | B. TUI embeds the daemon and starts the bridge | C. Keep separate, sync sessions |
|---|---|---|---|
| What changes | TUI client (exists), attach policy for one telegram session, approval fan-out, discovery file | TUI process starts gateway + pool + bridge in-process | A sync job copies transcripts and memory both ways |
| One brain | Yes, by construction: one session object in one process | Only while that TUI runs; a second TUI or the launchd daemon is a second poller on the same bot (Telegram allows one `getUpdates` consumer, the other gets 409) | No. Two loops with copied history diverge on every tool call |
| Approvals once | Yes: one `ChannelApprovals` instance decides | Yes, but only inside that TUI | No: two policy engines, two answers |
| Bot up when TUI closed | Yes (daemon is the service) | No | Yes |
| New moving parts | 1 discovery file, 1 approval fan-out path, 1 frame | Whole daemon lifecycle inside an Ink app, poller ownership lock | Sync engine, conflict rules, a second memory writer |
| Blast radius | ~6 files over three slices | `apps/tui` boot path, `packages/daemon/index.ts`, bridge start, locks | New package plus both stores |
| Offline | Falls back to today's in-process TUI, clearly labelled | Always works, but Telegram dies with the terminal | Works, diverges |
| Termux | Daemon started once per boot (section 4.7) | Works while Termux is foregrounded | Same as A |

**Recommendation: Option A.** The transport, the client, the echo, the journal
and the single-answer approval coordinator already exist; the gap is one
attach rule, one approval path for a loopback operator socket, and discovery.
B moves a service into an interactive process and creates two pollers on one
bot; C adds a sync engine that can never give "resolve once" because there are
two deciders. A adds the fewest parts and removes the second brain.

## 4. Design (Option A)

### 4.1 Session ownership

- The daemon owns every session. The TUI owns nothing in linked mode; it is a view
  plus an input box.
- **Home session.** Each daemon has at most one session bound to the Telegram
  operator: the bridge's existing `telegram` session (`connectDaemon`,
  `freshSession`). It stays `NEVER_EVICT`. On launch the TUI's first tab attaches
  to it. Nothing about its creation changes.
- **Attach rule.** `telegram` is added to what `attachLive` will bind, under three
  conditions checked together: the socket is loopback, the daemon has a token and
  the socket authenticated with it, and the session is the bridge's home session.
  It is still never listed for non-authenticated sockets, never written to
  `~/.8gent/sessions` by `persistSession` (the bridge keeps its own
  `telegram-sessions.json`), and never restorable from disk by a non-bridge socket.
- **`/new` on either surface** replaces the home session for both: the bridge's
  `freshSession` already destroys and recreates; the TUI receives `session:end`
  with reason `replaced` and re-attaches to the new id via a `home:changed` event.

### 4.2 Attach, detach, reconnect

- Attach: `session:attach { sessionId: "home" }` (alias resolved daemon-side, so
  the TUI never has to learn the id first). Reply is today's `session:attached`
  with the capped transcript.
- Detach (`/sessions detach`, or closing the tab): the session keeps running for
  Telegram. The TUI returns to an in-process session, labelled as such.
- Reconnect: `DaemonSessionClient` today ends the link on `onclose`. Change: keep
  the tab linked, retry with backoff (0.5s, 1s, 2s, cap 10s), re-`auth`, re-attach
  the same id, and replace the visible transcript with the returned one. A turn in
  flight keeps running daemon-side (journal, #4082). The TUI shows
  "Reconnecting to your 8gent..." and disables send, never silently switching to
  an in-process brain mid-conversation.
- Busy guard: the daemon already queues a second prompt behind a busy turn
  (`DAEMON-PROTOCOL.md` "Busy Guard"). A TUI prompt during a Telegram turn queues;
  the TUI shows "queued behind a Telegram turn".

### 4.3 Who runs tools

- Tools run in the daemon process, under the daemon's permission engine, in the
  session's working directory (`getWorkingDirectory()`). The home session's
  cwd is the daemon's configured `workingDirectory`, not the TUI's shell cwd. The
  TUI header shows that directory whenever it differs from `process.cwd()`.
- Extra TUI tabs that want the TUI's project cwd create a `tui` channel session
  with `overrides.workingDirectory = process.cwd()` (the path #3929 already uses
  for restored sessions). Those are not the Telegram home.
- Sandbox: `packages/permissions/run-command-sandbox.ts` applies to whichever
  process runs `run_command`. Unverified for this doc: that the daemon process
  enables the same sandbox profile the TUI does. Slice 2's test must assert it.

### 4.4 Approvals across channels

Model: **one decider, many doorbells.** `ChannelApprovals` stays the only thing
that resolves a request. Surfaces only answer.

- **Which turns ask.** A turn asks for approval when it was started by a socket
  that can carry a human: the bridge (today) or an authenticated loopback TUI
  socket (new). The gateway builds the `ApprovalTurn` for a TUI prompt itself
  (`{ chatId: "tui:<socketId>", operator: true, origin: "tui" }`); it never trusts a
  `turn` field from a non-bridge socket (the rule at `gateway.ts` line 678, `state.approvalBridge ? parseTurn(msg.turn)`, stays).
- **Who sees the card.** `approval:required` is already broadcast to every socket
  on the session (`subscribeToBus`). The TUI maps it to an inline card through the
  existing `useApprovalCard` UI. The bridge draws its card as today.
- **Who may answer.** `approval:response` is accepted from (a) the bridge socket,
  as today, and (b) a loopback, token-authenticated socket bound to that session
  with channel `tui`. Anything else gets `not-bridge`. `respond` already checks
  the request belongs to the socket's session.
- **Once.** First valid answer settles; `settle` deletes the entry, so the second
  gets `not-live`. New: `settle` emits `approval:closed { outcome: "answered",
  approver }` so the other surface removes its buttons and shows who answered.
  One audit line per request, `approver` = `telegram:<user id>` or `tui`.
- **Never wider.** These rules make a Telegram tap unable to widen the TUI:
  1. Always-blocked commands are never offered on any surface (unchanged,
     `permissions/index.ts` line 1254).
  2. Must-ask commands (#3748) stay refused in the daemon in slices 1 to 3. They
     are not offered to Telegram. Offering them to a TUI socket only is a later,
     separate decision.
  3. "Allow in this chat" allowances are keyed by `(session, chatId)` and honoured
     only on operator turns. A TUI turn's chatId is `tui:<socketId>`, so a
     Telegram allowance cannot match a TUI turn. Slice 2 adds the test that pins
     this, since today it holds only by key shape.
  4. A TUI-started turn's card is answerable from Telegram only by a full-tier
     operator (the bridge's operator check), never by the prompt tier.
  5. **Yolo does not cross.** Linked mode ignores `yolo.json`: the TUI shows
     "Yolo is off while linked to your 8gent on Telegram" and the daemon never
     reads it (unchanged). A TUI in yolo mode that links simply starts asking again.
- **Telegram-started turns** stay as today: the card goes to Telegram; the TUI
  also shows it and may answer it, because the TUI socket is the same operator on
  the same machine with the token. If James wants Telegram turns answerable only
  on Telegram, that is one flag (open question 2).

### 4.5 Auth on loopback

- **Token file.** The daemon writes `<dataDir>/daemon.token` (mode 0600, parent
  0700) on first start when no `daemon.authToken` is configured, and from then on
  refuses to start with auth disabled unless `EIGHT_DAEMON_NO_AUTH=1` is set
  explicitly. It refuses to read a token file whose mode is looser than 0600 or
  that is a symlink (same check shape as `telegram-setup.ts` `looser`).
- **Discovery file.** The daemon writes `<dataDir>/daemon.json` (0600):
  `{ "url": "ws://127.0.0.1:<port>", "pid": <n>, "dataDir": "<path>", "bridge": true|false }`.
  No token inside. The TUI resolves in order: `EIGHT_DAEMON_URL`, then
  `~/.8gent/daemon.json`, then `~/.8gent/*/daemon.json` whose `bridge` is true
  (this finds `eightgent-data` on this Mac), then `ws://127.0.0.1:18789`. It reads
  the token from the same directory as the discovery file it used.
- **Liveness.** The TUI treats a discovery file whose pid is dead as absent.

### 4.6 Multi-tab mapping

- One tab maps to one daemon session id; `useWorkspaceTabs` stores the id per tab.
- Tab 1 is the home session when a bridge is attached. Other tabs are `tui`
  channel sessions in the daemon (shareable, listed in `/sessions`), each
  counted against `MAX_SESSIONS = 10`. When the pool is full the TUI says so and
  offers an in-process tab instead of evicting anything.
- Telegram talks to exactly one session, the home. Moving Telegram to another tab
  (`/sessions telegram here`) is slice 3.

### 4.7 Termux (Android)

- No launchd, no systemd user units. Two supported starts:
  1. **Termux:Boot** script at `~/.termux/boot/8gent-daemon` running
     `termux-wake-lock; 8gent daemon run`. `service.ts` gets a third backend,
     `termux`, selected when `PREFIX` contains `com.termux`, whose install writes
     that script (data, testable like the other two backends).
  2. **TUI-started.** When no daemon is reachable and `EIGHT_TUI_DAEMON=spawn`
     (default on Termux only), the TUI spawns `8gent daemon run` detached and
     waits up to 5s for `daemon.json`. The daemon outlives the TUI.
- Android's phantom process killer can stop background processes on Android 12+.
  The fallback in 4.8 is what keeps the TUI usable when that happens; the doc for
  a contributor names `termux-wake-lock` and the developer option that disables the killer.
- Bun on Termux reports `process.platform` as `linux`; detection is by `PREFIX`,
  never by platform alone.
- **As built (#4878, checked 25 Oct 2026).** `service.ts` has a fourth platform,
  `android` (line 26), chosen by `servicePlatform()` (line 576) from Termux markers
  rather than `process.platform`. Its backend is termux-services (runit) under
  `$PREFIX/var/service/com.8gent.daemon`, driven by `sv`, not the Termux:Boot script
  above; without termux-services every operation says so and names `8gent daemon run`.
  `EIGHT_TUI_DAEMON=spawn` is not built.

### 4.8 Offline behaviour

| Condition | TUI | Telegram |
|---|---|---|
| No daemon reachable at launch | In-process session as today, header says "Local only, Telegram not linked" | Unaffected (or off) |
| Daemon drops mid-session | Reconnect loop (4.2), send disabled, no silent switch | Bridge reconnects itself every 5s (existing) |
| Model offline | Same error both surfaces, from the daemon | Same |
| Telegram API unreachable | Unaffected | Bridge poll watchdog (existing, #3708) |
| Daemon restarts with a turn in flight | Re-attach, transcript replaced, journal continues the turn | Same |

### 4.9 Telegram output rule

The bridge posts a final reply to Telegram only for a turn it started. A turn
started from the TUI is shown on the TUI only; Telegram sees nothing, which keeps
TUI work out of groups. The bridge records `turnOrigin` when it sends a prompt
and drops the final stream event of any other turn. Mirroring TUI turns into the
operator's private DM is an opt-in for later (open question 3).

### 4.10 Flow as a daemon client (open, owned by epic #4984)

8gent Flow is the other first-party surface, and epic #4984 ("one loop") wants the same
sessions in Flow and in the TUI. This design does not build that. What is true on
`9d08c8763`, and what a Flow client would need:

- **Today there is no `flow` channel.** `KNOWN_CHANNELS` (line 126 of the
  session pool module in `packages/daemon/`) and `SHAREABLE_CHANNELS` (`packages/daemon/shared-sessions.ts` line 25) have
  no `flow` entry, so a Flow socket cannot create a session that other clients may join,
  and cannot attach to one as a first-class surface. The `browser` and `app` entries are
  the nearest existing channels. This is a gap, not an omission in the code: nothing
  was decided.
- **The specification, when it is built.** A new shareable channel `flow`, added to both
  lists in one change. A Flow client connects the way the TUI does: loopback only, the
  daemon's `identify` challenge answered before any token or session is sent, the
  operator token from `local-link.ts`, `session:attach` by id or by the `home` alias.
  It gains no authority by attaching: `yolo.json` stays TUI-only, a Telegram "allow in
  this chat" never reaches a Flow turn, and a turn that needs a card is refused until
  slice 3 gives Flow a card surface too. Prompts to any pairing question default to No.
- **Gate.** Adding a channel changes what the daemon will share, so it needs the 8TO and
  8SO boardroom pass before any code (the same rule that held slice 1 until 8SO's three
  findings were fixed, #4830). Until that pass, `flow` is a gap owned by #4984 and this
  document does not authorize it.
- **The other direction already exists.** The TUI reaches Flow without the daemon:
  `packages/tools/flow-bridge.ts` (#4944) lets `web_fetch` ask the paired Flow browser tab
  on an Android phone to open a page, over `127.0.0.1` only, after the pairing proof is
  checked. Since #5017 the caller's destination guard is required: `bridgeFetch` takes
  `guard` as a mandatory option and runs it before any byte goes to Flow, so a refused
  destination never reaches the app. That bridge is a tool, not a session link: it carries
  one page fetch, not a conversation, and it does not make Flow a daemon client.

## 5. Security (for 8SO)

### 5.1 Local users and processes

- **Today:** no token, loopback bind. Any process of any local user can connect to
  `:18789` or `:18790`, `session:create`, and run a turn whose safe commands are
  auto-approved headless. The telegram session itself is not attachable (only the
  bridge may resume it), but a fresh session runs with the daemon user's files.
- **After slice 1:** token required by default (4.5). The token file is 0600 in a
  0700 directory, so another Unix user cannot read it. A process running as the
  same user can read it; that is the same trust as `~/.8gent` itself and is
  stated, not solved.
- Attaching the Telegram home session requires token plus loopback plus channel
  check, all three.

### 5.2 Browser and DNS rebinding

- `guardRequest` already refuses a foreign `Origin` and a foreign `Host` on every
  upgrade. A rebinding page sends its own hostname as `Host` and is refused; a
  cross-site page sends its own `Origin` and is refused.
- The token never goes in a URL for the TUI (header or first frame only). The
  `?token=` upgrade form stays for 8gent Browser and is not used here.
- `EIGHT_DAEMON_ALLOWED_ORIGINS` and `EIGHT_DAEMON_ALLOWED_HOSTS` widen the guard.
  Linked mode refuses to attach the home session when either is set to a
  non-loopback value, and says why.

### 5.3 Token theft

- Token is never logged, never put in a transcript, never sent to the model.
  `readDaemonToken` already holds that rule; slice 1 keeps it for the new path.
- Compare is constant time (`sameToken`).
- Rotation: deleting `daemon.token` and restarting the daemon issues a new one;
  every TUI re-reads it on reconnect. A stolen token is useless off-box because
  the shared verbs are loopback-only per frame, not just per bind.

### 5.4 Telegram allowlist tiers

- **Operator, full tier:** James, user id 100000001. Prompts, commands, approval
  taps, including taps on TUI-started turns.
- **Prompt tier:** a contributor, user id 100000002, on James's bot. Today prompts from
  this tier are refused outright (`isCommandAllowed`). This design does not change
  that: the home session is the operator's, with the operator's powers. A prompt
  tier sender gets their own deny-by-default session (Table-style `agentScope`)
  before they can prompt at all, in a separate issue. Prompt tier can never
  answer an approval card.
- **On a contributor's own phone,** a contributor is the operator of his own bot and daemon;
  the same tiers apply with his id as operator.
- **Observe tier:** unchanged, logged to `telegram-observed.jsonl`, never answered.

### 5.5 What 8SO should check on the slice PRs

1. A non-loopback socket with a valid token cannot attach the home session.
2. A loopback socket without the token cannot attach, prompt or answer.
3. A `tui` socket's `turn` field is ignored; the gateway builds the turn.
4. Prompt tier tap on a card returns `not-operator` and leaves the request live.
5. Two answers, one decision line.

## 6. Build plan

Each slice is one PR, one issue, tests run one file at a time, and a live check on
this Mac before the PR is called ready. A slice is not done until its live check
has output behind it. Order, as amended on 23 Oct: slice 1 auto-attach, slice 2 the
Telegram home session, slice 3 approvals.

### Slice 1: auto-attach (revised after the 8SO block on #4830)

Decision 1. 8SO blocked the first build (23 Oct, #4830) on three findings; the slice now
carries their fixes, so it is no longer TUI-only and about 400 lines with tests.

- **Opt in, this machine only.** `EIGHT_TUI_DAEMON=auto` turns auto-attach on, and it
  only ever goes to 127.0.0.1, ::1 or localhost. It becomes the default when slice 3
  (approvals) lands.
- **The daemon proves who it is first.** An `identify` challenge, answered with
  HMAC(secret, nonce) before auth; the client checks it before it sends a token or a
  session, for every link including explicit ones. The secret is `daemon.authToken`, or
  `<dataDir>/daemon.token` (0600) created at first start. No secret, no attach.
- **A daemon-run TUI turn never auto-approves.** With no approver bound, every request
  that reaches the prompt is refused. Approval cards for these turns are slice 3.
- Existing exposure on the explicit paths: #4836.

The behaviour below describes the original slice and still holds, apart from the
default being off. Slice 1 is on main (#4830).

Behaviour:
- On start, the TUI probes the local daemon: `EIGHT_DAEMON_URL` if set, else
  `ws://127.0.0.1:18789`. The probe is `GET /health` with a 600 ms budget; the
  answer must be the daemon's own `{"status":"ok"}` shape. The TUI never waits on a
  slow daemon: the first screen is drawn before the probe returns.
- If a daemon answers, the TUI attaches its own fresh session to it through the
  existing `linkDaemonSession` path (#3929), so the chat is a daemon session.
- A footer chip says so: `daemon attached`. The chip is a segment, not a toast, for
  as long as the link holds, because where tools run has changed (section 4.3).
- Detach is possible and sticky: `/sessions detach` (exists) returns to the in-process
  session and the TUI does not re-attach for the rest of the run. `EIGHT_TUI_DAEMON=off`
  turns auto-attach off for a person who never wants it.
- If no daemon answers, or the attach fails, the TUI runs exactly as today: no chip,
  no message on the quiet path, one plain system line only when an attach was tried
  and failed.

| File | Change |
|---|---|
| `apps/tui/src/lib/daemon-autoattach.ts` (built, #4830) | `autoAttachMode(env)`, `isLoopbackDaemonUrl(env)`, `autoAttachAllowed(env)`, `daemonHealthUrl(env)`, `hasTypedTurn(messages)`, `probeDaemon(healthUrl, { fetch, timeoutMs })`. Pure, injectable fetch. The chip is the `daemonAttached` prop on `StatusFooter`, not a function here. |
| `apps/tui/src/app.tsx` (built) | One effect that probes then calls `linkDaemonSession` once per run; a `daemonAttached` flag set by link and unlink (lines 1423, 3097, 3170), passed to the footer. |
| `apps/tui/src/components/StatusFooter.tsx`, `BottomBar.tsx` (built) | The `daemon attached` segment. |

Tests (`bun test <file>`, one at a time; `daemon-autoattach.test.ts`, the `StatusFooter` test and the `daemon-sessions` test exist on main):
- `daemon-autoattach.test.ts`: off by env; probe true on a daemon-shaped `/health`;
  false on a refused connection, a timeout, a non-JSON body and a wrong shape; the
  600 ms budget is enforced with a fake clock.
- `StatusFooter.test.tsx`: the chip shows when attached and is absent otherwise.
- `daemon-sessions.test.ts` (extend): a real `Bun.serve` stand-in daemon, the TUI
  client attaches, and `/sessions detach` leaves the session running.

Live check: with the daemon on `:18789` up, start the TUI and capture the chip; run
`/sessions detach` and capture the chip gone; stop the daemon, start the TUI, and
capture that it starts with no chip and no error. Recorded, not described.

What slice 1 does not do, stated so nobody assumes it: it does not link the Telegram
session (slice 2), so a Telegram message is not yet visible in the TUI; and until
slice 3 lands, a command that needs a card is refused in a daemon-run turn
(section 4.3, today's headless rule). Slice 1 should not reach a release before slice 3 (approvals).

### Slice 2: the Telegram home session (decided 23 Oct 2026, 8EO relaying James)

Pulled ahead of approvals: this is "open the TUI and your 8gents already have
Telegram". About 1,400 lines with tests (PR #4838, stacked on #4830). Every daemon change in it
gets 8SO review, so the PR carries a threat note.

What it does:
- **Home session.** The Telegram bridge declares which of its sessions carries
  the conversation (`home:declare`, honoured only from the socket that proved the bridge
  secret; the bridge holds two Telegram sessions in its default mode and the adapter's is
  the conversation). The latest declaration is home. `session:attach { sessionId: "home" }`
  (or its raw id) joins it. It is never listed, never written to the session store, never restored from disk.
- **Who may attach.** Loopback, and a socket that proved the operator token with an
  `auth` frame. Nothing else: not a non-loopback peer, not a loopback socket
  without the token, not by listing or guessing the id.
- **Token.** On start the daemon creates `<dataDir>/daemon.token` (0600, random,
  never in a log or a URL) when none is configured. It gates the home session. It
  does not gate the rest of the gateway by default, because the Mac app and other
  local clients connect without one today; `EIGHT_DAEMON_REQUIRE_TOKEN=1` makes it
  gate everything (open question 4). A configured `daemon.authToken` keeps its present meaning and is
  also the operator token.
- **Discovery.** The daemon writes `<dataDir>/daemon.json` (0600): url, pid, data
  dir, no token. The identity proof is bound to the address the client dialled, so a squatter
  cannot relay it. The TUI scans `~/.8gent/daemon.json` and `~/.8gent/*/daemon.json`,
  ignores dead pids, reads the token from the same directory, and tries `home` on each.
- **A dedicated tab.** `/sessions attach home` opens one tab, "Telegram", reused if open,
  labelled linked, reconnecting or detached. Only that tab is linked; no other tab or its
  messages is touched. Closing the tab detaches it, and it is never saved to disk.
- **Telegram output rule (4.9).** The daemon tags every turn-output event with the channel
  that started the turn (capability `turn-origin`); the bridge posts only events whose origin
  is Telegram and drops untagged ones. A TUI turn on the home session is shown in the TUI
  and never sent to Telegram, also across a bridge reconnect in the middle of it.
- **Reconnect.** The client keeps the link, retries with backoff, re-attaches the same
  id, replaces the transcript, and shows "Reconnecting". It never silently switches to
  an in-process session. Detach stops the retry.

| File | Change |
|---|---|
| `packages/daemon/local-link.ts` (built, #4838) | Token file and discovery file: create, read, refuse a symlink or a mode looser than 0600. |
| `packages/daemon/index.ts` | Create the token, pass it to the gateway, write and remove `daemon.json`. |
| `packages/daemon/gateway.ts` | `operatorToken`, an `operator` flag set by `auth`, the home session id, passed to the shared-session verbs. |
| `packages/daemon/shared-sessions.ts` | `home` alias; the telegram attach rule; no persist mark for it. |
| `packages/daemon/telegram-bridge.ts` | Post finals only for the bridge's own turns. |
| `apps/tui/src/lib/daemon-sessions.ts` | Discovery, token from the discovered dir, `connectHome`, reconnect with backoff. |
| `apps/tui/src/app.tsx` | `/sessions attach home`, and the reconnecting and resynced lines. |

Tests: token and discovery file modes and refusals; the attach rule at unit level
(operator, alias, never listed, never persisted); a real gateway with a bridge socket
and a TUI socket (no token refused, wrong token refused, token attaches, echo carries
`tui`, store never holds the telegram session); the bridge posts nothing for a TUI
turn; client discovery order, dead pid ignored, reconnect after a daemon restart.
Live check: the real bot daemon and bridge on this Mac, a recorded TUI attaching to
`home`, one line typed each way.

Slice 2 is on main (#4838). Having auto-attach on launch (slice 1) try `home` first is one line now that both are merged; it is not done yet.

### Slice 3: approvals for daemon turns

Decision 2. Proves success checks 2 and 3. About 250 lines. Moved from slice 2.

| File | Change |
|---|---|
| `packages/daemon/gateway.ts` | Build the `ApprovalTurn` for a loopback, operator `tui` prompt; accept `approval:response` from that socket. A `turn` field from a non-bridge socket stays ignored. |
| `packages/daemon/channel-approvals.ts` | `approval:closed { outcome: "answered", approver }` on settle; origin on the turn. |
| `apps/tui/src/lib/daemon-sessions.ts` | `approval` and `approval-closed` chat events; `respond(requestId, decision)`. |
| `apps/tui/src/app.tsx` | Route daemon approval events into the existing approval card; yolo off while linked. |
| `packages/daemon/telegram-bridge.ts` | Close its card on `answered` and say who answered. |

Tests: `channel-approvals` unit test for two responders, one settle, one audit line;
gateway test that a Telegram `allow_chat` never auto-approves a TUI turn; gateway
test that a `tui` socket's supplied `turn` is ignored; TUI test that a linked session
never reads `yolo.json`; a sandbox parity assertion for the daemon (section 4.3).

Live check: on the home session, a Telegram-started turn raises a card; the TUI shows
it; one yes in the TUI runs the command exactly once and the audit log has one decision
line. Then the same from a TUI-started turn answered on Telegram.

Also in this slice or after: per-tab session ids, the offline header and the Termux
backend (sections 4.6 to 4.8).

## 7. Questions

Decided (section 1.1): 1. attach on launch by default, yes. 2. the TUI may answer
cards for Telegram turns, yes. 5. Sequencing: the Telegram home session is slice 2,
approvals slice 3 (8EO, 23 Oct 2026, on James's intent).

Open, with the default that stands until James answers:
3. TUI-started turns: never posted to Telegram. Default: never (built that way in slice 2).
4. Token by default. Slice 2 creates the token and gates only the home session; the
   rest of the gateway stays open for existing local clients. Full enforcement is
   `EIGHT_DAEMON_REQUIRE_TOKEN=1`. Default: opt-in until the Mac app and the other local
   clients read the token.
