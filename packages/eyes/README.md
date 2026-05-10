# @8gent/eyes

Perception layer for the 8gent body-parts taxonomy. Eyes capture, annotate, locate, describe, wait, diff, and observe. Hands act on what eyes locate.

## Status

Contract: shipped (#2497, #2500).
First backend: Peekaboo (#2501, this package).

See:

- [`docs/specs/EYES-SPEC.md`](../../docs/specs/EYES-SPEC.md) - full contract, types, decisions, headless CLI parity.
- [`docs/specs/EYES-BACKEND-PEEKABOO.md`](../../docs/specs/EYES-BACKEND-PEEKABOO.md) - first backend rationale, swap path.

## Why a separate package

Hands act, eyes perceive. The split mirrors motor cortex vs visual cortex. `packages/hands` keeps motor primitives; eyes owns perception. This keeps body-parts independent and individually testable.

## Quick start

```ts
import {
  selectEyesBackend,
  DEFAULT_FAILOVER,
  grantPerceptionRemote,
  type Eyes,
  type VisionProvider,
} from "@8gent/eyes";

// 1. Pick the first available backend (peekaboo on Mac).
const backend = await selectEyesBackend([...DEFAULT_FAILOVER]);
if (!backend) {
  console.log("Eyes: install peekaboo with `brew install steipete/tap/peekaboo`");
  process.exit(0);
}

// 2. Inject a vision provider (used by describe + locate kind:"describe").
//    Two-phase contract per spec §4.2:
//      resolveProviderId(req) -> provider id (no inference call)
//      describe(req)          -> actual inference (after tier check)
//    The eyes backend uses resolveProviderId to gate perception:remote
//    BEFORE the model is called, so frame bytes never leave the device
//    when the tier denies. The shared `eyesVisionProvider` adapter at
//    packages/ai/eyes-vision-provider.ts is the canonical impl; build
//    your own only if you need a custom routing policy.
const visionProvider: VisionProvider = {
  async resolveProviderId(_req) {
    // Return the provider id that WILL handle this request.
    // No model call here.
    return "ollama";
  },
  async describe(req) {
    // Actual inference. Caller (eyes backend) has already done the tier check.
    return { provider: "ollama", model: "qwen2.5-vl", text: "..." };
  },
};

// 3. (Optional) grant perception:remote for this session if the chain
//    resolves to a remote VLM. The control plane normally does this in
//    response to a 3-button consent UX per spec §4.2.
grantPerceptionRemote("session", { sessionId: "current-session" });

const eyes: Eyes = backend.create({ visionProvider, sessionId: "current-session" });

// 4. Use eyes.
const frame = await eyes.capture();           // focused display by default
const annotated = await eyes.annotate(frame); // AX walk -> elements w/ ids + bboxes
const hits = await eyes.locate(
  { kind: "label", text: "Sign in" },
  annotated,
);
if (hits[0]?.target && "point" in hits[0].target) {
  // hand the point off to @8gent/hands
}
```

## Permission model

| Operation | Tier required |
|---|---|
| `capture`, `captureAll`, `annotate`, `locate` (id/label/role), `wait_for` (most), `diff`, `observe` | base `computer-use` (gated upstream by control plane) |
| `describe`, `locate({kind:"describe"})`, `wait_for({kind:"describe_matches"})` AND resolved provider is remote | additional `perception:remote` (gated by `grantPerceptionRemote()`) |
| same calls AND resolved provider is local (`8gent`, `ollama`, `apfel`, `apple-foundation`, `lm-studio`) | base only |

The remote check fires on the **runtime resolved provider id**, not on backend identity. A `describe()` call that the failover chain happens to satisfy locally never trips the remote tier.

Every call is audit-logged via `@8gent/audit`. See `~/.8gent/audit/access.db`.

## Backend authors

Implement `EyesBackend` and call `registerEyesBackend(b)`. Mirror the Peekaboo descriptor shape:

```ts
import { registerEyesBackend, type EyesBackend } from "@8gent/eyes";

const myBackend: EyesBackend = {
  id: "ax-native",
  platforms: ["darwin"],
  minOSVersion: "13.0",
  available: async () => /* probe */ true,
  create: () => /* return Eyes impl against the spec */,
};

registerEyesBackend(myBackend);
```

## Tests

```bash
cd packages/eyes
bun run typecheck
bun test
```

Integration tests against the real Peekaboo CLI run when the binary is installed AND Screen Recording + Accessibility entitlements are granted. Otherwise they self-skip with a console note.

## Issues

- #2496 - perception capability spec
- #2497 - spec + scaffold (merged)
- #2500 - §8 RFC decisions (merged)
- #2501 - Peekaboo backend (closed by PR #2502)
- #2503 - `apps/8gent-eyes` headless CLI (follow-up)
- #2504 - tool registration in `packages/ai/tools.ts` + agent-loop wiring (follow-up)
