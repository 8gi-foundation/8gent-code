# @8gent/hands

Placeholder package. Reserved for the **8gent-hands** fork of
[`trycua/cua`](https://github.com/trycua/cua) (MIT), adapted for the 8gent
Computer on-device Mac agent.

## Status

Scaffold only. No driver code has been vendored.

- Parent PRD: [#1746](https://github.com/8gi-foundation/8gent-code/issues/1746)
- Architecture spike: PR [#1747](https://github.com/8gi-foundation/8gent-code/pull/1747)
- This scaffold issue: [#1755](https://github.com/8gi-foundation/8gent-code/issues/1755)

## Attribution plan

When cua code lands here, the fork will preserve the upstream MIT license and
note attribution in a `LICENSE-cua` file plus a `NOTICE` block in this README.
Nothing is imported yet, so no attribution is required at this stage.

## TODO (later PRs, not this one)

- Import a scoped subset of cua's macOS computer-use driver.
- Bridge to the Swift app via the daemon WebSocket channel on
  `ws://localhost:18789` (see parent PRD correction comment).
- Add TCC entitlement handling per Karen's threat model (#1748).
- Tests against a headless desktop harness.

## Non-goals

- Linux / Windows support.
- Generic browser automation (that lives elsewhere).
- Any work that requires Screen Recording or Accessibility prompts until the
  security review in #1748 signs off.
