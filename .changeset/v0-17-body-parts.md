---
"@8gi-foundation/8gent-code": minor
"@8gent/eyes": minor
"@8gent/handeyes": minor
---

Body-parts taxonomy: eyes (perception) + handeyes (sensorimotor coordination) shipped end-to-end alongside hands (motor, already shipped). The agent now sees and selectively coordinates eyes+hands when stuck.

- **Eyes**: full Eyes contract (capture, annotate, locate, describe, wait_for, diff, observe), bundled native AX bridge (no Homebrew dependency), perceptual diff with real changed-region detection, vision-router with Ollama and OpenRouter, two-phase VisionProvider closes the privacy bug, agent tools `eyes_*` registered, headless `apps/8gent-eyes/` CLI.
- **Handeyes**: third body-part. 5 compound tools (`handeyes_locate_and_click`, `handeyes_click_and_verify`, `handeyes_type_and_confirm`, `handeyes_engage_struggle_mode`, `handeyes_exit_struggle_mode`). Selective tandem-mode engagement on 4 trigger heuristics (3 live: zero-hits-twice, wait-for-timeout, click-without-screen-change; trigger 4 from DoomLoopDetector emitter wired but pending shared-instance accessor).
- **DoomLoopDetector** now extends EventEmitter and emits `'stuck'` for push-style cycle notification per RFC #2527.

Conceptual ancestry for the AX bridge: Peekaboo (MIT, Peter Steinberger 2025). Full attribution at `packages/eyes/native/NOTICE`.
