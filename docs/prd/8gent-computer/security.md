# Security Spec: 8gent Computer

Status: draft spec, no code yet.
Parent PRD: [#1746](https://github.com/8gi-foundation/8gent-code/issues/1746).
Closes [#1748](https://github.com/8gi-foundation/8gent-code/issues/1748).
Related: voice-ipc spec (`docs/prd/8gent-computer/voice-ipc.md`), PR [#1747](https://github.com/8gi-foundation/8gent-code/pull/1747).

This document defines the security posture for 8gent Computer: key material,
on-disk encryption, TCC entitlements, the tier-based memory gate, the
bundle-id screen-capture deny-list, and the threat model. It does not ship
Swift, Qdrant wiring, or daemon code. It defines seams and policies only.

A separate PR wires the code per this spec.

---

## 1. Keychain + AES-256 at rest

### 1.1 Key name and service

The per-install AES-256 master key lives in the macOS login Keychain with:

- **Service**: `com.8gent.computer.master-key`
- **Account**: `default` (reserved for multi-profile in v2)
- **Keychain class**: `kSecClassGenericPassword`
- **Protection class**: `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`
  - Key is unavailable before first unlock, never syncs to iCloud, never
    leaves this machine.
- **Access Group**: `GROUPID.com.8gent.shared` where `GROUPID` is the
  Apple Developer Team ID prefix (TBD on first DMG build, recorded in
  `apps/8gent-computer/Entitlements.plist` on first signing).
- **Key format**: 32 raw bytes (256 bits), generated via
  `SecRandomCopyBytes`, base64-encoded for storage as the password value.

The Access Group is shared between the Swift app (`com.8gent.computer`),
the local daemon helper (`com.8gent.daemon`, if shipped as a signed helper),
and the TUI binary when invoked from the same user session. No other
bundle id may be added to the group without a Karen sign-off.

### 1.2 Lifecycle

1. **First run**: Swift app checks for the key. If absent, it generates 32
   random bytes via `SecRandomCopyBytes`, writes via `SecItemAdd`, and
   derives the per-collection data-encryption keys (DEKs) via HKDF-SHA256
   with collection-name as `info`. Master key never leaves Keychain.
2. **Steady state**: app and daemon request the master key via
   `SecItemCopyMatching` at process start, cache the derived DEKs in
   process memory only, zero on exit. The master key bytes are never
   logged, never sent over the daemon socket, never written to disk
   outside Keychain.
3. **Rotation**: user-triggered only from Settings > Security > Rotate
   encryption key. Rotation performs: (a) generate new master, (b)
   re-derive DEKs, (c) decrypt-and-re-encrypt Qdrant volume and SQLite
   secrets, (d) atomically replace Keychain entry, (e) force-restart
   daemon. There is no automatic time-based rotation in v1. Automatic
   rotation is a v2 decision.
4. **Wipe**: user-triggered from Settings or via signed remote wipe from
   `eight-vessel.fly.dev` (protocol in section 7). Wipe performs
   `SecItemDelete` plus secure delete of `~/.8gent/qdrant/` and
   `~/.8gent/memory.db`. Irreversible. No key escrow in v1.

### 1.3 Swift app and daemon sharing

Both processes read the key from the same Keychain Access Group. The
daemon runs as a LaunchAgent under the user's UID, not root, so it uses
the same login keychain the Swift app uses. The daemon does not get its
own keychain file and does not embed the key in its binary. First call
to Keychain from the daemon after a reboot triggers the standard "allow
this app to access Keychain" prompt; after the user clicks "Always
Allow" the prompt is not shown again for the signed daemon binary.

### 1.4 Reuse of existing SecretVault

`packages/secrets/index.ts` already implements an AES-256-GCM vault, but
it derives its key from `hostname + username` via PBKDF2 with a static
salt (`packages/secrets/index.ts:42-47`). That is a machine-binding
fallback suitable for API key storage on headless vessels. It is NOT
suitable as the master key for 8gent Computer because the fingerprint is
predictable. 8gent Computer uses the Keychain-resident random key
described above. The SecretVault continues to serve its current purpose
for API key storage; on 8gent Computer installs we MAY migrate it to
wrap its vault key under the same Keychain master (tracked as a
follow-up, not blocking v1).

---

## 2. Qdrant encryption at rest

### 2.1 The gap

Qdrant (open source) does not encrypt its on-disk storage natively.
Customer-side encryption is the only option. We need a filesystem-layer
wrapper that mounts a decrypted view at `~/.8gent/qdrant/` only while
the daemon is running and the master key is available.

### 2.2 Decision: APFS encrypted volume via `hdiutil` sparse bundle

Three options were considered:

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **APFS encrypted sparse bundle** (`hdiutil create -encryption AES-256`) | First-party Apple, no third-party dep, works offline, user trusts it, grows dynamically | User sees a mounted volume in Finder (minor surprise), one disk image per install | **Selected** |
| **cryfs** | Per-file encryption, no fixed volume size | Third-party dep, slower random reads (Qdrant is read-heavy), not signed by Apple, extra install step | Rejected |
| **gocryptfs** | FUSE-based, mature, fast | Requires macFUSE kext or FUSE-T, which drags a kernel extension or user-space FUSE driver into the trust boundary. Blocker. | Rejected |

Selected: encrypted APFS sparse bundle at
`~/.8gent/qdrant-volume.sparsebundle`, mounted at `~/.8gent/qdrant/` on
daemon start, unmounted on daemon stop or system shutdown. The
encryption password is the base64 of the Keychain master key, passed to
`hdiutil attach -stdinpass` over a pipe, never written to disk or argv.

### 2.3 Mount protocol

1. Daemon start. Fetch master key from Keychain.
2. If `~/.8gent/qdrant-volume.sparsebundle` does not exist, create with
   `hdiutil create -size 16g -encryption AES-256 -fs APFS -volname "8gent-qdrant"`.
   Initial size is 16 GB sparse (grows on demand, consumes real disk
   only as used). 16 GB accommodates ~10M vectors at 768 dim float16
   with metadata; revisit at v2 if usage trends higher.
3. Attach via `hdiutil attach -mountpoint ~/.8gent/qdrant -stdinpass`.
4. Start Qdrant bound to `127.0.0.1:6333` with data dir at the mount
   point. Reject 0.0.0.0 binds at daemon level: daemon passes an explicit
   `--bind 127.0.0.1` flag; any config that overrides this refuses to
   start.
5. Daemon shutdown or user lock: `hdiutil detach ~/.8gent/qdrant`. If
   Qdrant is still writing, daemon sends SIGTERM, waits 5 seconds, then
   SIGKILL before detach. Detach is idempotent and tolerates "already
   detached" errors.

### 2.4 Qdrant distribution: bundled binary, not Docker

The PRD (#1746) reads `Qdrant.swift - Local Docker client`. Karen's
recommendation: **do not ship Docker as a dependency**. Reasons:

1. Docker Desktop is 800 MB, adds a license check surface (Docker's own
   ToS for commercial users), and runs its own VM which is an extra
   attack surface the user does not expect from a desktop app.
2. A qdrant-client Rust/Go binary compiled for arm64 and x86_64, signed
   and notarised, runs inside our trust boundary directly. Keychain
   access stays in our process tree.
3. Qdrant publishes static-linked binaries. We vendor the version we
   test, sign it as part of the app bundle, and launch it as a child
   process of the daemon.

v1 ships bundled Qdrant binary. Docker path is not supported.

### 2.5 Fallback: SQLite-only memory

If bundle notarisation of the Qdrant binary is blocked (e.g. Apple
rejects a non-Apple-signed executable in the app bundle even after we
sign it), the fallback is **SQLite-only memory via
`packages/memory/store.ts`** which is already implemented with FTS5
lexical search plus the existing embeddings table. Vector quality is
worse but the app ships. Karen's decision: SQLite-only is acceptable
for v1 if Qdrant bundling blocks the DMG. The sensitivity-tier gate
(section 4) and the Keychain key (section 1) apply regardless of
which backing store is used.

---

## 3. TCC entitlements

### 3.1 Required entitlements

For the Swift app bundle `com.8gent.computer`:

| Entitlement | Purpose | User prompt? | Can pre-provision? |
|-------------|---------|--------------|---------------------|
| `com.apple.security.app-sandbox` | MAS requirement, defence in depth | No (silent) | Yes, ship as true |
| `com.apple.security.cs.hardened-runtime` | Codesign flag, notarisation requirement | No | Yes, ship as true |
| `com.apple.security.cs.allow-jit` | Webview JIT for in-app browser | No | Yes |
| `com.apple.security.network.client` | Daemon WebSocket, provider HTTPS, in-app browser | No | Yes |
| `com.apple.security.device.audio-input` | Voice input via packages/voice | **Yes, Microphone prompt** | No, must trigger on first use |
| `com.apple.security.files.user-selected.read-write` | User picks folders for agent work | Via Open panel | Yes |
| `NSScreenCaptureUsageDescription` (Info.plist string) | 8gent-hands screen capture | **Yes, Screen Recording prompt** | No |
| `NSAppleEventsUsageDescription` (Info.plist string) | 8gent-hands click/type via AX | **Yes, Accessibility prompt** | No |
| `com.apple.security.automation.apple-events` | Drive other apps via AppleEvents | **Yes, per-target-app prompt** | No |
| Keychain Access Group `GROUPID.com.8gent.shared` | Share master key with daemon | No (user sees "Always Allow" prompt first time each process accesses) | Partial |

Pre-provisionable means the entitlement is in the .entitlements file and
active from first launch. User-prompt entitlements cannot be
pre-approved: Apple requires the user gesture. Our consent sheet (Moira's
ticket) surfaces the prompt deliberately and explains what happens next.

### 3.2 Sandbox or not

App-sandbox **on** is the default. 8gent-hands (the computer-use
driver) requires `NSScreenCaptureUsageDescription` and
`com.apple.security.automation.apple-events`, both of which are
sandbox-compatible with the right temporary-exception entitlements on
specific target bundle ids.

### 3.3 Path A (notarised DMG) vs Path B (Mac App Store)

Path B (MAS) blocks the current design because:

1. MAS requires sandbox **hard-lock**: the computer-use driver cannot
   call arbitrary bundle ids without enumerating them at submission
   time.
2. MAS review cycles add days between security patches.
3. Loading a bundled Qdrant binary triggers MAS rejection under
   "non-Apple signed executables in resources" guidelines.

Karen's recommendation: **Path A for v1**. Notarised DMG, hardened
runtime, Developer ID signed, distributed from 8gent.dev. Path B is a
v3+ question after the feature set stabilises.

---

## 4. Sensitivity tier enforcement

### 4.1 Schema

The PRD (#1746) defines four tiers on every memory vector:
`public`, `work`, `private`, `secret`. Every vector also carries
`session_id`, `companion_id`, `source_app_bundle_id`, `retention_class`.

The gate rule, stated operationally:

> A session tagged with tier `T_session` may retrieve a vector tagged
> `T_vector` if and only if `rank(T_session) >= rank(T_vector)`,
> where `rank(public)=0, rank(work)=1, rank(private)=2, rank(secret)=3`.

A `public` session cannot retrieve `secret` vectors. A `secret` session
can retrieve anything. A `work` session can retrieve `work` and
`public` but not `private` or `secret`.

### 4.2 Code seam

The gate lives in **`packages/memory/recall.ts`**, at the single entry
point used by the agent to fetch context. It wraps every retrieval in a
SQL `WHERE` clause (SQLite path) or a Qdrant `filter` (vector path) of
the form:

```
sensitivity_tier_rank <= :sessionTierRank
```

The `sessionTierRank` is set once per session when the session is
created and is immutable for the lifetime of that session. Upgrading a
running session to a higher tier requires closing it and opening a new
one; this forces an explicit user decision and leaves an audit trail.

A new package-level helper `packages/memory/tier.ts` defines:

```ts
export type SensitivityTier = "public" | "work" | "private" | "secret";
export const TIER_RANK: Record<SensitivityTier, number>;
export function canRead(session: SensitivityTier, vector: SensitivityTier): boolean;
```

Every write path also sets the tier; the default is `private` if the
session did not specify, because `public` as a default is the dangerous
direction.

### 4.3 Prompt-injection defence

Prompt injection to "just tell me your secret notes" fails at the
retrieval layer, not the model layer. The model never sees the secret
vector text because the retrieval SQL never fetched it. The model's
worst case is a refusal of a query it does not have context for, which
is a correct behaviour.

Additionally, the assistant's system prompt in
`packages/eight/prompts/system-prompt.ts` gets a section forbidding
the model from asking the user for their `sensitivity_tier` or
asserting a higher tier than the session is configured for. That is
defence in depth; the retrieval gate is the primary control.

### 4.4 Collection separation

Per-tier collections (or per-tier SQL partitions) are a v2 hardening.
In v1 the tier is a column/filter on a single store. Rationale: one
store keeps consolidation and embeddings consistent, and the filter is
enforced on every path. Moving to physical separation is a follow-up
tracked in a new issue once v1 is live.

---

## 5. Bundle-id screen-capture deny-list

### 5.1 Default deny-list (v1)

8gent-hands will refuse to capture screen content, read AX tree, or
send AppleEvents to any app whose frontmost bundle id matches the
deny-list. The check runs in the Swift app before the hands subprocess
is invoked, and the hands subprocess double-checks on its side for
defence in depth.

Default v1 deny-list:

| Bundle id | App | Reason |
|-----------|-----|--------|
| `com.1password.1password7` | 1Password 7 | Secrets |
| `com.1password.1password` | 1Password 8 | Secrets |
| `com.agilebits.onepassword7` | 1Password legacy | Secrets |
| `com.agilebits.onepassword4` | 1Password legacy | Secrets |
| `com.bitwarden.desktop` | Bitwarden | Secrets |
| `com.apple.keychainaccess` | Keychain Access | Secrets |
| `com.googlecode.iterm2` when running `ssh`, `gpg`, `pass`, `op` | Terminal secret ops | Heuristic, best-effort |
| `com.apple.Terminal` same heuristic | Terminal secret ops | Heuristic |
| `org.whispersystems.signal-desktop` | Signal | E2EE messaging |
| `net.whatsapp.WhatsApp` | WhatsApp | E2EE messaging |
| `com.apple.Mail` | Apple Mail | PII, likely legal/medical |
| `com.apple.MobileSMS` | Messages | PII, E2EE for iMessage |
| `com.apple.iChat` | Messages legacy | PII |
| `com.tinyspeck.slackmacgap` | Slack | Work PII, requires per-workspace consent |
| `com.microsoft.teams2` | Teams | Same |
| `us.zoom.xos` | Zoom | Video, mic content |
| `com.bankofamerica.BofAMobileBanking` | BofA | Financial |
| `com.chase.sig.Chase` | Chase | Financial |
| `com.wellsfargo.mobile.banking` | Wells Fargo | Financial |
| `com.revolut.RevolutPay` and `com.revolut.Revolut` | Revolut | Financial |
| `com.apple.Preview` when PDF title matches `/passport\|tax\|medical\|prescription/i` | Sensitive docs | Heuristic |
| `com.apple.Health` | Health | PHI |
| `com.apple.FaceTime` | FaceTime | Video, mic |

### 5.2 Karen-added to Moira's initial list

Additions over and above James's sketch:

- 1Password 8 `com.1password.1password` (the old bundle id is the legacy
  one; both must be listed).
- Keychain Access itself.
- iMessage / Messages, FaceTime, Apple Mail.
- Terminal apps running secret-adjacent commands (heuristic).
- Microsoft Teams, Zoom.
- Revolut (both bundle ids).
- Apple Health for PHI.

### 5.3 Enforcement seam

Lives in `packages/permissions/policy-engine.ts` as a new policy
`screen-capture-deny-list` that returns `deny` for any tool invocation
with `tool == "screen.capture" | "ax.read" | "apple.event"` and
`frontmost_bundle_id in DENY_LIST`. The list is shipped as a YAML file
at `packages/permissions/default-policies.yaml` and loaded at daemon
start. User can add to the list in Settings. User cannot remove from
the default list without a `--i-know-what-im-doing` toggle that logs a
policy decision to the audit store.

### 5.4 Nicholas (COPPA) default

For sessions with `user=nick`, the entire screen-capture capability is
disabled by default (not just deny-list filtered). To enable for a
specific creative task, James must explicitly toggle it in a per-
session consent sheet. See section 6 row `COPPA`.

---

## 6. Threat model matrix

| Threat | Attack surface | Current mitigation | Residual risk | Action needed |
|--------|----------------|---------------------|----------------|---------------|
| **Evil maid** (laptop stolen, powered off) | Disk at rest, Keychain file, Qdrant sparse bundle | FileVault is assumed on (user responsibility, install-time check warns if off). Keychain master key is `WhenUnlockedThisDeviceOnly`. Qdrant sparse bundle is AES-256. | If FileVault is off and the Mac is booted, Keychain access requires login password; attacker with unlocked session wins. | Installer blocks install if FileVault is off, with a "how to enable" link. Issue to file: `install: require FileVault` |
| **Evil maid while booted and unlocked** | Running processes, mounted Qdrant volume | Daemon detaches Qdrant on screensaver lock (new). Sensitivity tiers prevent bulk exfil via prompt if attacker logs in as user but the session-tier is low. | Attacker who logs in as user at higher tier wins. This is always true of any local app. | Auto-detach on screensaver lock. Issue to file: `daemon: detach qdrant on screen lock` |
| **Malicious local process** | Localhost Qdrant port, daemon Unix socket, daemon WS port 18789 | Qdrant binds 127.0.0.1 only. Daemon WS validates origin header, rejects cross-origin. Daemon socket permission 0600. Master key only leaves Keychain into signed, hardened-runtime processes. | Another process running as the same user can read Keychain after a one-time "Always Allow" if impersonating our bundle id with a matching code signature, which requires a stolen Developer ID. | Pin daemon WS to require a per-install shared secret, not just origin. Issue: `daemon: pre-shared secret for WS auth` |
| **Prompt injection extracting cross-tier memory** | Retrieval layer | Sensitivity-tier gate at `packages/memory/recall.ts` (section 4). | Injection against same-tier data still works (not a cross-tier threat). | Document tier-scoping in agent prompt. Issue: `prompts: add tier-scoping guard` |
| **Sensitive-app screen-capture leak** | Screen Recording permission, 8gent-hands subprocess | Bundle-id deny-list (section 5). Double-check in hands subprocess. | User can override defaults; heuristics (terminal, preview) are best-effort. | Audit log every deny-list override. Issue: `audit: log deny-list overrides` |
| **COPPA (Nicholas)** | Any collection, screen capture, retention | `user=nick` sessions write to isolated collection tag `nick-*`, screen capture disabled by default, retention class `child-short` caps at 30 days with daily redaction scan for PII. No cloud sync for nick sessions ever. | Parental supervision assumed; not a technical control beyond above. | Ship the `child-short` retention class. Issue: `memory: child-short retention` |
| **GDPR right-to-forget** | All on-disk stores | Single command `8gent memory forget --user=<id>` that deletes from SQLite, Qdrant, embeddings, and the audit log (audit-log entries get tombstoned, not deleted, with a `forgotten=true` flag and no PII). Runs within 30 days of user request. | Backups (none in v1, local only) are out of scope. | Implement `memory forget`. Issue: `memory: GDPR forget command` |
| **Daemon process injection** | Daemon binary on disk, LaunchAgent plist | Developer ID signed, hardened runtime, notarised. LaunchAgent plist in `~/Library/LaunchAgents/` owned by user, 0644. | Attacker who already has user-level write to LaunchAgents can swap the binary. This is a broader OS compromise. | Periodic code-signature self-check on daemon start. Issue: `daemon: self-check signature on start` |
| **Remote wipe abuse** | `eight-vessel.fly.dev` command channel | Signed commands only, Ed25519, per-install public key registered at install time on the vessel. Nonce prevents replay. | Fly.io compromise = ability to send signed-looking commands, but the vessel does not hold the Ed25519 private key (held by James offline). | Document the key-custody protocol. Issue: `vessel: remote-wipe key custody doc` |
| **Telemetry leak** | Any outbound HTTP from daemon | Local-first default, no analytics in v1. When cloud is opted in, the provider chain only contacts the provider endpoints. | User adding a provider API key means that provider sees prompt content by design. | Clear consent copy for cloud opt-in. Moira owns. |

---

## 7. Open items that need James's call

### 7.1 Remote wipe protocol

Proposal: `eight-vessel.fly.dev` exposes a `POST /v1/wipe` that the
daemon polls every 60 seconds with a short-poll. Payload is:

```
{ "installId": "<uuid>", "nonce": "<32 random bytes>", "issuedAt": "<iso>", "sig": "<ed25519>" }
```

The daemon verifies against a public key baked into the binary at build
time. If James's private key is stolen, every install needs a new
binary; this is accepted. Alternative: keypair per install with the
public half stored on the vessel at first boot. I lean toward the
per-install keypair because it limits blast radius, but it is more
complex. **Needs James's call.**

### 7.2 Kill-switch shortcut

Global shortcut `Cmd+Opt+Esc` is Apple's force-quit combo and cannot
be rebound without accessibility workarounds. Proposal: `Cmd+Shift+8`
as "pause all agents, drop current tool chain, revoke current-session
tier for 60 seconds". Ships as a menubar item too. **Needs a product
call; not strictly a security call.**

### 7.3 FileVault install gate

Blocker if off, or warning if off? Security posture says blocker.
Product says this is a friction cost on a free-tier user who has not
turned FileVault on. I recommend **blocker** with a one-click help
link. **Needs James's call.**

---

## 8. Acceptance (for closing #1748)

- This doc merged.
- Qdrant-vs-SQLite recommendation stated (section 2.4, 2.5): **bundled
  Qdrant binary, SQLite fallback if notarisation blocks bundling**.
- DMG-vs-MAS recommendation stated (section 3.3): **Path A, notarised
  DMG, v1**.
- TCC entitlement table checked in (section 3.1).
- Open items section flags remote-wipe protocol, kill-switch, FileVault
  gate for James to resolve on separate issues.

## 9. Not in scope for this doc

- Swift code. A follow-up PR per `apps/8gent-computer/` lands
  Entitlements.plist and Keychain helpers per this spec.
- Qdrant bundling harness. Tracked in the PR that actually vendors the
  binary.
- Specific AppleScript / AX bridge code in 8gent-hands.
- EU AI Act compliance beyond right-to-forget; tracked in the
  compliance workstream, not this doc.
- Formal legal review of the remote-wipe signed-command protocol.
  Counsel review required before production.
