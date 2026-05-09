# Eyes Backend: Peekaboo

Status: DRAFT, paired with `EYES-SPEC.md`. Issue: 8gi-foundation/8gent-code#2496.

## 1. Summary

Peekaboo (https://github.com/openclaw/Peekaboo, MIT, macOS 15+) is a Swift CLI that captures the screen, walks the macOS Accessibility tree, annotates frames with element IDs, runs vision models against frames, and exposes an MCP server. It is the strongest off-the-shelf candidate for the first `Eyes` backend.

This document records why we adopt the concept (not the code), what we extract, what we explicitly do not adopt, and what the swap path to a different backend looks like.

## 2. License and constraints

- **License:** MIT. Compatible with Apache 2.0 (8gent-code's license). No copyleft, no FSL/BUSL/SSPL trap. Per the Openwork lesson (2026-04-25), license-checked first.
- **Platform:** macOS 15.0+ (Sequoia). Swift 5.9, Xcode 16+.
- **Permissions:** Requires Screen Recording and Accessibility entitlements granted by the user.
- **Distribution:** Homebrew (`brew install steipete/tap/peekaboo`), npm wrapper (`@steipete/peekaboo`), or build from source.

The macOS-only constraint is acceptable for v0. The Eyes interface (per the spec) is platform-neutral; Linux and Windows backends slot into the same interface later.

## 3. What we adopt (concept, not code)

The valuable concepts that map onto the Eyes contract:

| Eyes operation | Peekaboo concept | What we take |
|---|---|---|
| `capture` | `image` / `see` | Use Peekaboo's CLI as the capture path. PNG out, displayId support. |
| `annotate` | `see` returns element IDs | Adopt the model: AX walk produces stable element ids per frame. |
| `locate` (`kind: "label"`) | `click --on B12` semantics | Element IDs as the primary locator. |
| `locate` (`kind: "describe"`) | `image --analyze` | Vision-model query against a frame. |
| `describe` | `image --analyze` | Same. |
| `wait_for` (`element_visible`) | implicit in `agent` loop | Build on top of `see` + poll. |
| Permission probe | `permissions` | Use directly to surface "missing entitlement" cleanly. |
| AX enumeration helpers | `menu`, `menubar`, `dock`, `dialog`, `app`, `window`, `space`, `list` | Pull element types from these into our `AnnotatedElement` taxonomy. |

We invoke Peekaboo as a subprocess and parse JSON, exactly the way `packages/hands` invokes `cliclick` and `screencapture`. No native bridge, no Swift module. Concept-extraction within the No-BS rule.

## 4. What we explicitly do not adopt

These are deliberate omissions for v0:

- **Action commands.** `click`, `type`, `drag`, `hotkey`, `scroll`, `swipe`, `move`, `set-value`, `perform-action`, `press` overlap with `packages/hands`. We do not route hands through Peekaboo. Hands stays as it is.
- **`agent` subcommand.** Peekaboo ships its own multi-step natural-language loop. We have our own agent loop in `packages/eight/agent.ts`. Not adopted.
- **`mcp` server mode.** We have our own MCP plumbing. Not adopted.
- **Workflow runner (`run`, `.peekaboo.json`).** Out of scope.
- **`config` for AI providers.** Eyes uses our provider chain, not Peekaboo's. We pass frames to our vision models, not Peekaboo's.

The boundary: Peekaboo gives us frames + AX annotation + a screenshot-analyze API. Everything else, we already have or do not need.

## 5. Adapter shape

```ts
import type { EyesBackend, Eyes } from "@8gent/eyes";

export const peekabooBackend: EyesBackend = {
	id: "peekaboo",
	platforms: ["darwin"],
	minOSVersion: "15.0",
	available: async () => {
		// shell out: `which peekaboo` and `peekaboo permissions --json`
	},
	create: () => createPeekabooEyes(),
};
```

`createPeekabooEyes()` returns an `Eyes` implementation that shells out to the Peekaboo binary for `capture`, `annotate`, `describe`, and a polling implementation of `wait_for`. Same pattern as `packages/hands` shelling out to `cliclick`.

## 6. Install path

The user installs Peekaboo themselves; we do not bundle it. The TUI surfaces a one-liner the same way it does for `cliclick`:

```
Eyes: peekaboo not installed.
Install: brew install steipete/tap/peekaboo
After install, run: peekaboo permissions --grant
```

Eyes returns `available: false` when the binary is missing. The agent loop survives.

## 7. Swap path to other backends

The Eyes interface is the contract. Peekaboo is one implementation. Two others are tractable:

1. **`ax-native`.** A small native module (or Swift bridge) that uses the macOS Accessibility APIs directly, no subprocess. Eliminates the install step, lower latency. Same `Eyes` interface. This becomes the preferred backend once the contract is stable.
2. **`remote-vlm`.** Send a frame to a remote vision-capable model through the existing provider chain. Pure cloud, no local entitlements. Useful for headless / CI / Linux. Lower fidelity for AX-driven `locate` because there is no AX tree.

The failover chain in §5 of the spec encodes the preferred order: AX-local first, remote-VLM last.

## 8. Risks

- **Peekaboo upstream pace.** It is an active project; CLI flags can change. Mitigation: pin the version in our `available()` probe, surface upgrade prompts.
- **Element ID stability.** Peekaboo element ids are stable per frame, not across frames. Our `Locator` type already encodes this (locators are scoped to an `AnnotatedFrame`).
- **AX coverage gaps.** Electron / non-AX-friendly apps return sparse trees. Mitigation is the vision fallback in `locate`, already part of the contract.
- **Open-fork lineage.** `openclaw/Peekaboo` is a fork of the upstream `steipete/peekaboo`. Verify license + maintenance status of the chosen fork before pinning. Both are MIT today.
- **Single-vendor risk.** First backend should not become the only backend. The Eyes spec is written backend-neutral specifically to make `ax-native` and `remote-vlm` cheap to add.

## 9. Decision

Adopt Peekaboo as the first Eyes backend, by concept-extraction (no code merged into our tree, subprocess invocation only). Build the `peekaboo` adapter behind the `Eyes` interface in a follow-up PR after this spec lands.
