# Eyes Backend: native AX bridge

Status: ACTIVE, paired with `EYES-SPEC.md`. Issue: 8gi-foundation/8gent-code#2496.

## 1. Summary

The macOS backend uses a bundled Swift helper at `packages/eyes/native/swift/`. The helper compiles to a single executable installed at `~/.8gent/bin/8gent-ax-bridge` and is spawned by the TS adapter (`packages/eyes/backends/ax-native.ts`) one command per call. The bridge wraps Apple system frameworks directly: `CGDisplay*` for displays, `NSScreen` for retina/scale, `CGWindowListCopyWindowInfo` for windows, the `AXUIElement*` C API for the AX tree, and `/usr/sbin/screencapture` for capture.

This replaces the v0 design (#2501) which shelled out to the Homebrew `peekaboo` binary. The new design preserves the Eyes contract bit-for-bit; only the runtime backend changes. Conceptual ancestor: Peekaboo (MIT, Peter Steinberger). Attribution lives in `packages/eyes/native/NOTICE`.

## 2. Why drop the external dependency

- **Install ceremony.** Homebrew install + tap registration was a per-user setup blocker.
- **Version drift.** Peekaboo's CLI shape can change; pinning it across users is fragile.
- **License drag.** External binaries pull a separate update + audit cycle.
- **Latency.** Bundled binary skips Homebrew indirection and TCC negotiation flakiness.
- **Distribution.** A single Swift sources tree ships in the repo; one build script produces the binary; no third-party package server in the loop.

## 3. License and constraints

- **License:** Apache 2.0 (matches 8gent-code). The Swift bridge is original code in our tree.
- **Conceptual ancestry:** Peekaboo (MIT, Copyright 2025 Peter Steinberger). Per-file headers in vendored algorithm patterns credit Peekaboo. Full MIT terms reproduced in `packages/eyes/native/NOTICE`.
- **Platform:** macOS 13.0+ (Ventura). Swift 6 (ships with Xcode 16).
- **Permissions:** Screen Recording + Accessibility, granted by the user in System Settings then Privacy & Security.
- **Distribution:** in-repo Swift sources; build via `bash packages/eyes/native/build.sh`; output at `~/.8gent/bin/8gent-ax-bridge`. No external package server.

## 4. What the bridge implements

| Eyes operation | Bridge command | What it returns |
|---|---|---|
| `capture` | `image` | PNG to a path; logical size + scale factor metadata. |
| `annotate` | `see` | UI elements with stable per-frame ids, roles, bounds, value. |
| Screen enumeration | `list-screens` | Index, displayID, isPrimary, scaleFactor, bounds. |
| Frontmost window | `list-windows` (`app:"frontmost"`) | Window bounds for focused-display detection. |
| Permission probe | `permissions` | Screen Recording + Accessibility status with grant instructions. |

`describe` is NOT in the bridge. Vision routing is TS-side via the injected `VisionProvider` adapter; the backend gates `perception:remote` BEFORE inference per spec §4.2.

`wait_for`, `diff`, `observe`, and `locate` are pure TS; they call `capture` + `annotate` and never the bridge directly.

## 5. Bridge protocol

Stdin or argv. One JSON envelope to stdout, then exit:

```json
{ "success": true, "data": <command-payload>, "error": null }
{ "success": false, "data": null, "error": { "code": "PERM_AX", "message": "..." } }
```

Argv form (used by the TS adapter):

```bash
8gent-ax-bridge <command> --json-args '{"...": "..."}'
```

Stdin form (handy for manual testing):

```bash
echo '{"command":"list-screens"}' | 8gent-ax-bridge
```

The envelope shape is identical to what the v0 Peekaboo wrapper parsed, so the rest of the eyes package keeps the same `BridgeResult<T>` typing.

## 6. Adapter shape

```ts
import type { EyesBackend } from "@8gent/eyes";

export const axNativeBackend: EyesBackend = {
	id: "ax-native",
	platforms: ["darwin"],
	minOSVersion: "13.0",
	available: async () => {
		// resolve binary at ~/.8gent/bin/8gent-ax-bridge
		// run --version + permissions probe
	},
	create: (opts) => createAxNativeEyes(opts),
};
```

`createAxNativeEyes()` returns an `Eyes` impl that spawns the bundled binary for `capture`/`annotate` and runs the rest in TS. Same shape the v0 Peekaboo backend exposed; same `BackendOpts` surface.

## 7. Build and install

```bash
bash packages/eyes/native/build.sh
# output: ~/.8gent/bin/8gent-ax-bridge
```

The script builds in release mode with Swift PM, copies the binary into the install dir, and smoke-tests `--version`. It self-checks for Xcode CLT and aborts with an actionable hint if `swift` is not on PATH.

If a postinstall hook is wired at the monorepo root, the script runs once on `bun install` so users do not have to invoke it.

## 8. Failover

The Eyes interface is the contract. The bridge is one implementation. The failover chain in `packages/eyes/index.ts` registers `ax-native` first and falls through to `remote-vlm` (cloud, lower fidelity for AX-driven locate) on hosts where the bridge is not built or entitlements are missing.

Future backends (`uia-native` for Windows, `at-spi-native` for Linux) slot into the same registry.

## 9. Risks

- **macOS API churn.** `CGDisplayCreateImage` is deprecated on 14.4+. The bridge uses `/usr/sbin/screencapture` as the primary capture path and falls back to `CGDisplayCreateImage`. ScreenCaptureKit is a future swap when we need streaming.
- **AX coverage gaps.** Electron / non-AX-friendly apps return sparse trees. Mitigation is the vision fallback in `locate`, already part of the contract.
- **Permission UX.** First-run TCC prompts are unavoidable. The bridge surfaces actionable grant instructions in its `permissions` envelope.
- **Build dependency.** Users now need Xcode CLT. This is a one-time install; the Apple toolchain is the price of running native macOS code. Documented in §7.

## 10. Decision

Replace the external Peekaboo dependency with the bundled native bridge. Keep the Eyes contract unchanged. Vendored algorithm patterns retain Peter Steinberger's copyright per MIT terms. Swap path to `remote-vlm` and Linux/Windows backends remains intact.
