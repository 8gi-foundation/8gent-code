# @8gent/handeyes

Sensorimotor coordination. The third body-part in the 8gent taxonomy.

| Package | Role | Depends on |
|---|---|---|
| `@8gent/hands` | motor only (click, type, scroll, drag) | nothing |
| `@8gent/eyes` | perception only (capture, locate, observe) | nothing |
| `@8gent/handeyes` | coordination | `hands` AND `eyes` |

`handeyes` is the only package in the body-parts spine that depends on both. Everywhere else, hands and eyes stay independent and individually testable.

## Why a third package

Most of the time, the cheap path works: `eyes.find(...)` -> `hands.click(...)`, done in two calls. No coordinator needed. We do not want a coordinator on every interaction, because:

- It adds latency to the common case.
- It hides which body-part actually failed when something goes wrong.
- It blurs the body-parts taxonomy that is the public spine of the brand.

Coordination earns its keep when the cheap path breaks. That is what `handeyes` is for. It engages selectively, runs while the agent is stuck, and disengages when forward progress resumes.

## When it engages

Default mode is sequential cheap. `handeyes` engages when ANY of these fire:

1. `eyes.find` returns zero hits twice in a row for the same query.
2. `wait_for` times out.
3. A click is followed by no observe()-detected screen change within 1.5s.
4. The DoomLoopDetector (`packages/eight/tool-loop-detector.ts`, shipped under #2461) catches a period-N cycle in the tool stream.

The agent can also engage it explicitly via `engageStruggleMode(reason)` when it self-diagnoses that it is stuck.

Engagement is transient. It exits automatically when forward progress resumes.

## How to consume

```ts
import { selectHandeyesAdapter, DEFAULT_ADAPTER_ORDER } from "@8gent/handeyes";

const adapter = await selectHandeyesAdapter([...DEFAULT_ADAPTER_ORDER]);
if (!adapter) {
	// Surface "engagement unavailable" to the agent loop. Never throw.
	return;
}

const handeyes = adapter.create();

const result = await handeyes.locateAndClick(
	{ kind: "label", text: "Sign in" },
	{ locateRetries: 2, verifyChanged: true },
);

if (!result.ok) {
	// result.reason and result.escalatedTo tell you what to do next.
}
```

The compound calls (`locateAndClick`, `clickAndVerify`, `typeAndConfirm`) cover the most common flows. The struggle-mode calls (`engageStruggleMode`, `exitStruggleMode`) are the explicit self-rescue lever.

## What this package does NOT do (yet)

This is the contract-only landing. The follow-up PR adds:

- The orchestrator-backed adapter that spawns the eyes-worker and hands-queue sub-agents.
- The DoomLoopDetector hook that engages struggle mode automatically.
- Tool-surface registration in `packages/ai/tools.ts`.
- Tests for trigger heuristics, tandem-mode lifecycle, and retry exhaustion.

The engagement loop is blocked on the perceptual-diff work in #2525, because the trigger "no observable change after click" needs region-aware diff events to fire usefully. The contract here does not depend on #2525 landing first.

## Spec

`docs/specs/HANDEYES-SPEC.md`. Read that before changing this contract.

## Issue

Contract scaffold: #2526. Engagement loop follow-up: TBD after #2525.
