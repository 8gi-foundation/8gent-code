# @8gent/eyes

Perception layer for the 8gent body-parts taxonomy. Eyes capture, annotate, locate, describe, wait, diff, and observe. Hands act on what eyes locate.

This package contains the contract only. The first backend (Peekaboo, MIT, macOS 15+) lands in a follow-up PR.

## Status

Draft RFC. See:

- [`docs/specs/EYES-SPEC.md`](../../docs/specs/EYES-SPEC.md) - full contract, types, failover chain, headless CLI parity, open questions.
- [`docs/specs/EYES-BACKEND-PEEKABOO.md`](../../docs/specs/EYES-BACKEND-PEEKABOO.md) - first backend rationale, what we adopt vs rebuild, swap path.

## Why a separate package

Hands act, eyes perceive. The split mirrors motor cortex vs visual cortex. Today `packages/hands` does both because screenshot lived next to click. Eyes makes perception its own thing so we can add real perception primitives - locate by description, vision-model describe, wait_for, frame diff, change observation - without piling them onto the motor layer.

The screenshot duplication between hands and eyes is acknowledged. Eyes initially calls into `hands.screenshot()`; the migration is a follow-up issue.

## Install

```bash
bun install
```

This package is workspace-internal. Consumers import from `@8gent/eyes`:

```ts
import { selectEyesBackend, DEFAULT_FAILOVER, type Eyes } from "@8gent/eyes";

const backend = await selectEyesBackend([...DEFAULT_FAILOVER]);
if (!backend) {
	console.log("Eyes: no backend available. Install one of: peekaboo, ax-native.");
} else {
	const eyes: Eyes = backend.create();
	const frame = await eyes.capture();
	const description = await eyes.describe(frame);
	console.log(description.summary);
}
```

## Backend authors

Implement `EyesBackend` and call `registerEyesBackend(b)` at module load. See the spec §7 for the contract.

```ts
import { registerEyesBackend, type EyesBackend } from "@8gent/eyes";

const myBackend: EyesBackend = {
	id: "my-backend",
	platforms: ["darwin"],
	available: async () => /* probe */ true,
	create: () => /* return Eyes impl */,
};

registerEyesBackend(myBackend);
```

## Issue

[#2496](https://github.com/8gi-foundation/8gent-code/issues/2496)
