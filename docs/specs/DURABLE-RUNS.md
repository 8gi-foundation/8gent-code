# Durable runs on Pi Durable

Status: slice 1 built behind `EIGHT_DURABLE_RUN=1` (`packages/durable-run/`). Refs #4883. Owner: 8TO.

## Goal

A run survives a crash, continues exactly where it stopped from any client (TUI tab, Telegram tab,
phone), and never repeats an outside effect. Artale's Android phone is the first user.

## What we take, and from whom

Pi Durable, `@earendil-works/pi-durable` 1.4.0, from the pi project (github.com/earendil-works/pi,
Mario Zechner). MIT, and so are its runtime dependencies `@earendil-works/pi-ai`, `chord`,
`pi-codemode`, `pi-telemetry` and `typebox`; `@silvia-odwyer/photon` is Apache-2.0 and `diff` is
BSD-3-Clause. The MIT notice is kept in `packages/durable-run/THIRD_PARTY_NOTICES.md` and the PR body. We
install it as a dependency, pinned exact. No file of theirs is copied.

It needs Node 22.19 or newer (`engines`) and `node:sqlite`, which Bun 1.4 and Node 22 both ship, so
one storage path serves both runtimes. Termux ships Node 22 or newer for arm64; the package has no
native module (photon is WebAssembly, loaded only if imported). Weight: about 3.5 MB of its own
code plus `pi-ai`'s provider SDKs, which the bundler drops for the providers we do not import.
Unverified here: a run on the phone itself. That is Artale's acceptance run.

## Mapping

| Need | Pi Durable | Ours today | Decision |
| --- | --- | --- | --- |
| Commit before showing, resume after a crash | Harness over SQLite, atomic commits, `resume()` | JSONL intent and effect ledger, turn summary (`DURABLE-TURNS.md`, #4805 to #4809) | Pi's store takes over the run state. Our ledger stays for the effect rows and for the TUI path until the flag is the default. |
| Per-tool rerun rule | `replay: "safe"` or unsafe | read-only list, everything else asked | Ours is richer: `safe`, `once`, `ask` (below). Mapped onto Pi's two values. |
| No repeated outside effect | A tool with an effect needs its own idempotency | Idempotency key `<session>:<call id>`, write hash check | Kept, in a SQLite effect table beside Pi's tables. Pi alone does not give exactly once. |
| Resume from any client | Same storage, `requestId` returns the same submission | `--resume` per client, person driven | Slice 1 proves a second process resumes. The daemon becomes the single owner (below). |
| Session pool, gateway, auto-attach (#4829), Telegram tab (#4834) | One process owns a storage; no cross-process lock | Daemon pool holds sessions; clients attach by id | Keep. The daemon opens the run storage; clients attach through the gateway as now. A client with no daemon opens the file itself, which is safe only while no daemon runs. |
| Wake router (#4868, issue #4874) | `wake()` and `onWake`, sleeping tasks | Queue plus a speak-or-stay-quiet rule | Keep ours as the router. Feed it Pi's `wake()` so a sleeping task or a resumed run raises one event. |
| Crash-loop guard | `restartLimit`, parked tasks | Not built | Take Pi's. |
| Compaction, child tasks, forks | Built in | Own compaction (`COMPACTION-SPEC.md`) | Not in slice 1. Adopt Pi's when sessions move over. |
| Permission gate | `beforeTool` hook, once, before the intent | `evaluateToolCall`, `systemOneGate` | Ours stays. It runs INSIDE every tool's execute, so it stands in front of every execution, replays included. A `beforeTool` hook would run once and miss the rerun. |

## The replay rule

Each tool declares `replay`. No declaration counts as `ask`.

- `safe`: reads only. Rerun freely after a cut. Pi: safe.
- `once`: an outside effect. A finished call is never run again; its stored result is returned. A call cut
  off mid-effect runs again only if the tool is `idempotentByKey`, meaning the target honours the key we pass
  (a write with a hash check, a send layer that dedupes). Otherwise it is not rerun and is listed as unresolved.
  Pi: safe, because the effect table makes the rerun harmless.
- `ask`: anything else. Never rerun; listed for a person. Pi: unsafe, so the model gets an `interrupted` result.

Honest limit: exactly once needs a target that dedupes. Real Telegram has no idempotency key, so a send
that dies between the network call and its record cannot be told apart from one that never left. Our send
tool therefore stays `once` without `idempotentByKey`: at most once, and an unknown outcome is shown, not
resent. The kill test pins both rows.

## Slice 1 and what it proves

`openRun` (`packages/durable-run/run.ts`) runs one session's loop through Pi Durable over
`~/.8gent/runs/<id>.sqlite`, mode 0600 (folder 0700, the -wal and -shm files inherit it). The kill test
(`durable-run.test.ts`) SIGKILLs a real `8gent durable-run` process at every tick, which is every SQLite write
Pi makes, every effect boundary and every gate call, then resumes from a second process. Not in slice 1: our own
providers behind Pi's model layer (the test uses Pi's scripted provider), compaction, the daemon owning the
storage, the TUI entry. Those are slice 2.
