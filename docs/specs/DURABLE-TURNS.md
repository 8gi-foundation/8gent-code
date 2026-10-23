# Durable turns

Status: slice 1 built (intent and effect ledger, resume report, retry or skip). Slice 2 built (a turn
cut off with no tool running continues where it stopped; on by default in the TUI). Owner: 8TO.

## Who and the job

Artale runs 8gent on Android in Termux. 4G drops, Android kills Termux in the background, the
phone sleeps. A turn dies mid-tool. He needs the next `8gent --resume` to pick up where the turn
stopped: nothing done is lost, and no side effect (a file write, a command, a push) runs twice
without him deciding.

## What 8gent persists today, and what a kill loses

| Store | Path | What | When written | Read on `--resume` |
| --- | --- | --- | --- | --- |
| Session log v2 | `~/.8gent/sessions/<8gent session id>.jsonl` (`packages/specifications/session/writer.ts`) | user_message, step_start/end, tool_call, tool_result/tool_error, assistant_content | One `writeSync` per entry, no fsync. `tool_call` is written after the permission gate and before the tool executes, in all three loops (native `startAllowedTool`, the text-tool loop, `run_batch` `noteToolStart` in the `packages/eight` turn loop). The fd is reopened by path if lost (#4774, #4776). | No. It is keyed by the 8gent's own `session_<ms>_<rand>` id, which `--resume` never sees. |
| Session tree | `~/.8gent/sessions/tree/<id>.jsonl` (`packages/eight/session-manager.ts`) | Chat text only: user and assistant messages, no tool calls (`chatMessages`) | A 5 s poll in `apps/tui/src/app.tsx` when the message count grew, and on Ctrl+C | Yes. This is what `--resume` restores. |
| Time-travel checkpoints | `packages/eight/timetravel/checkpoint-store.ts` | Message history, content-addressed | Every `EIGHT_CHECKPOINT_EVERY` tool calls (default 8) | No. `/rewind` reads them by hand. |

**Lost on a SIGKILL between a tool starting and its result being recorded:** the `tool_call`
row reaches disk (the page cache survives a process kill, only power loss drops it), but
nothing reads it back; `--resume` restores chat text saved up to 5 s before the kill, so the
interrupted turn's tool calls, results and reply are gone from what 8gent and the person see,
nobody is told a write was in flight, and asking again can redo it.

## Prior art (concepts only, no code taken)

- **Pi Durable** (Fragmented ep. 312; #4777 comment). The loop is a while loop with phases
  written down. The "effect sandwich": store the intent, do it, store the result. On restart
  an intent with a result is done; an intent without one is retried. Snapshots are explicit,
  chosen by the loop.
- **dquickts** (stencil-hq/dquickts; Artale's reverse-engineering notes,
  `~/.8gent/research/2026-10-23-artale-re-report.txt`). QuickJS that suspends running JS at
  interrupt-counter safepoints and writes the whole heap, including a suspended call stack, as
  a base plus delta snapshot. `JS_SuspendCall` / `JS_ResumeWith` park a host call so its answer
  can arrive in another process. The snapshot header carries a build-signature hash, and a
  snapshot only loads into the build that wrote it. The durable REPL persists by writing a temp
  file and renaming it over the target, so the file always holds a complete state.
- **pi**: a JSONL tree session with compaction stored as a summary entry; 8 built-in tools.

What we lack against dquickts: we cannot freeze a running process. Our tools are host side
effects (files, shells, networks) that no heap snapshot captures, so we do the Pi move instead:
record the boundary of every side effect and resume between them. What we borrow: the build
signature (slice 3 stamps each ledger with the 8gent version and refuses a silent resume across
a tool-schema change) and atomic temp-then-rename for any state file that is rewritten rather
than appended (the slice 2 turn summary). The ledger itself is append-only, so it needs no rename.

## Parity with Pi Durable

Checked on 23 Oct 2026 against the public source: `earendil-works/pi`
`packages/durable/README.md` and `CHANGELOG.md`, and `earendil-works/pi-durable-cloudflare`.
Concepts only, no code taken. Status: **#4805** = slice 1, **slice 2** = this change,
**slice 3** = the parallel build (verified effects, build signature, headless `-p` resume).

| Pi Durable does | Ours | Where |
| --- | --- | --- |
| Commits the tool call's intent before `execute()` runs | Intent record, fsynced, before the tool runs | #4805 |
| Commits the tool result; a call with a result is done and never rerun | Effect record; a closed call never comes back | #4805 |
| A tool cut off mid-call reruns only if declared `replay: "safe"`; otherwise the model gets an `interrupted` result | Read-only tools are listed as safe to rerun; anything else goes to the person (`/durable retry` or `skip`), never replayed. Stricter than Pi: a person decides, not the model | #4805 |
| Partial answers committed every 100 ms; a crash loses at most that window | Streamed text written to the turn summary every 250 ms, finished step text as `step`, both scrubbed. Kept and shown on resume | slice 2 |
| A generation phase cut off reruns from its top on reopen; the run continues where it stopped | A turn with no `end` record is offered "Continue where it stopped": the request is re-sent with the text so far and the finished tool calls named as not to repeat | slice 2 |
| Survives process death: conversation, model turns, tool calls, own state | Ledger plus the session tree. Model turns and the reply so far now survive too | #4805 + slice 2 |
| Atomic commits (all or nothing) | Ledger is append-only with fsync, torn last line skipped; the turn summary is written temp-then-rename | #4805 + slice 2 |
| Storage error or network failure: reopen and resume, nothing lost | A dropped connection (fetch failed, ECONNRESET, idle stream) leaves the turn open and offers continue at once; any other error ends the turn | slice 2 |
| Idempotent submit: a retried `requestId` returns the same submission | Idempotency key `<session>:<call id>` on every intent. Tools honouring it (`git_commit`, `write_file` hash check) | key: #4805, honoured: slice 3 |
| Resume is driven by the host calling `resume()`; tasks found pending continue without asking | The person drives it on the next launch (`--resume`), Termux has no supervisor. Continue is one command, not automatic | #4805 + slice 2 |
| On by default: durability is the harness itself, there is no off switch | On by default in the interactive TUI. `--no-durable` or `EIGHT_DURABLE=0` opts out | slice 2 |
| Crash-loop guard: a task cut off `restartLimit` times (default 5) is parked | Not built. A turn is only continued when the person asks, so it cannot loop on its own | not needed yet |
| Stored work outlives code: a task blocks if its definition is missing or unmigratable | Build signature in the ledger header; refuse a silent resume across a tool-schema change | slice 3 |
| Headless hosts (Cloudflare Durable Object) resume on wake | Headless `8gent -p` resume | slice 3 |
| Code mode scripts journal nested call results and resume mid-script | Not doing: we have no deterministic sandbox for model-written scripts | not doing |

## Design

### The ledger

One append-only JSONL file per session, `~/.8gent/sessions/durable/<session id>.jsonl`, keyed by
the same id `8gent --resume` takes (the tree store id). Records:

| `k` | Written | Fields |
| --- | --- | --- |
| `turn` | A person's message starts a turn | `at`, `msg` (their text, secret-scrubbed, 4000 chars) |
| `step` | A model step finished with text | `text` (secret-scrubbed, 16000 chars) |
| `end` | The turn returned, or the person closed it on resume | `how` (`done`, `skip`, `continue`) |

Streamed text of the step in flight is not appended to the ledger. It is kept in memory per
session and written into the turn summary (`<id>.turn.json`, temp-then-rename) every 250 ms,
scrubbed as one string so a key split across stream chunks is still caught, and so a long
stream does not grow the ledger. A kill loses at most 250 ms of text. The summary is built from
running state in memory (seeded from the ledger once per process), never by re-reading the ledger.
| `intent` | After the permission gate, before the tool runs | `id` (tool call id), `tool`, `argsHash` (sha256 of the logged args, 16 hex), `key` (idempotency key `<session>:<call id>`), `hint` (path, command or url, 120 chars), `at` |
| `effect` | The tool returned or failed | `id`, `ok`, `digest` (sha256 of the result, 16 hex), `at` |
| `resolve` | The person chose on resume | `id`, `how` (`retry` or `skip`), `at` |

Raw arguments and results are not copied: the session log already holds them, and the ledger
must stay small enough to read on every resume on a phone.

### fsync policy

Every record is opened, written, fsynced and closed before the call continues. An intent is on
the flash before the side effect starts; an effect is on the flash before the next step. Open per
record means there is no long-lived descriptor to lose (the #4774 class of bug). The cost is one
fsync per tool boundary, milliseconds against tool calls that take seconds. A torn last line from
a kill mid-write is skipped on read; every record before it stands.

The file is opened like the session log (#4774, #4776): `O_NOFOLLOW`, regular file only, 0600 on
the file and 0700 on the folder even when they existed before. Hints go through the tool runner's
secret scanner (`packages/eight/secret-scanner.ts`), and URL query strings and credentials are
removed, because a hint is shown on resume and sent to the model by `/durable retry`.

Why not next to the session log: that file is keyed by the 8gent's own session id, which
`--resume` never sees, and it is written without fsync. The ledger is keyed by the resume id so
resume finds it with no index, and it stays small enough to read whole on a phone.

### Resume rules

1. Open calls are intents with no effect and no resolve.
2. A read-only tool (`isReadOnlyTool` in `packages/eight/tool-registry.ts`) is safe to run again.
   It is listed, not asked about.
3. Anything else is surfaced to the person, never replayed: "write_file notes.md: this may or may
   not have happened." `/durable retry` or `/durable skip`.
4. `skip` writes `resolve` records and carries on. `retry` writes them and sends 8gent a prompt
   built from the ledger summary, not the raw history: the open calls, which may have happened,
   and the instruction to check the current state first and redo only what is missing.
5. A closed call never comes back: a second resume asks nothing.

### Termux constraints

No launchd or systemd, so no supervisor restarts the process: recovery happens on the next launch,
driven by the person. Android kills the process without a signal handler running, so nothing may
depend on an exit hook; every boundary is written synchronously as it happens. Flash storage is
slow to fsync, so the ledger holds hashes and hints, not payloads.

## Durable as a named mode of 8gent-code

Durable is a mode of the same 8gent-code, not a fork.

- **On by default in the interactive TUI since slice 2**, because Pi Durable is durable by
  default (see the parity table). `8gent --no-durable` or `EIGHT_DURABLE=0` opts out.
- Headless runs (`8gent -p`, `--rpc`) never load the TUI entry and stay off unless
  `EIGHT_DURABLE=1`. Headless resume is slice 3.
- `/durable` toggles it; `/durable on|off` sets it.
- The footer shows `durable on` while it is on.

The release that ships slice 2 names the default change in its notes. Artale's three recorded runs
on Android (kill mid-write, kill mid-model-call, 4G drop mid-stream) remain the acceptance gate
for calling it done on the phone.

## Slices

1. **Built.** Intent and effect for every tool call in the native, text-tool and `run_batch`
   loops (one tap in `SessionWriter.write`), the resume report, `/durable retry|skip`, the
   `--durable` flag, the footer segment. Test: `durable-ledger.test.ts` SIGKILLs a real child
   process between a write's intent and its effect, then resumes and asserts the write happened
   once and the person is asked.
2. **Built.** A turn cut off with no tool open (killed while waiting on the model, a 4G drop
   mid-stream, the phone sleeping). The ledger records the person's message (`turn`), each
   finished step's text (`step`), and `end` when the turn returns; streamed text (tapped in the
   streamed-reply readers in `packages/ai/text-tool-endpoint.ts`) goes to the turn summary every
   250 ms. All model text is secret-scrubbed before it reaches disk. A turn with no
   `end` is shown on `--resume`, or at once after a dropped connection, with its text so far and
   the tool calls that finished. `/durable continue` (alias `retry`) re-sends the request with that
   text kept and the finished calls named as not to run again; `/durable skip` closes it. The turn
   summary `~/.8gent/sessions/durable/<id>.turn.json` is rewritten temp-then-rename at every step,
   effect and end. A symlinked `~/.8gent/sessions` or `durable` folder is refused before anything
   is created in it. Test: `durable-ledger.test.ts` SIGKILLs a real child mid-SSE-stream after a
   finished write, then asserts the partial text is kept, the write is named as finished and not
   open, and the file was written once.
   Limit: partial text mid-step exists only for streamed replies (the text-tool path, and any
   path with `EIGHT_STREAM_IDLE_MS`). The native AI SDK path receives each step whole, so a kill
   mid-step there keeps the finished steps and re-sends the request.
3. **Built** (`packages/specifications/session/durable-verify.ts`). Each intent carries `build`
   (`EIGHT_BUILD_ID`, else package version plus git sha) and `check`, what resume verifies:
   `write_file` the sha256 of the content; `edit_file` the sha256 of the file after an exact,
   unique replacement (anchored or ambiguous edits carry none and are asked); `git_commit` HEAD,
   a digest of the index (`ls-files -s`, read only, no tree object written) and the message,
   done when HEAD is that commit on that parent and its tree (`ls-tree -r`) gives the same digest.
   A path whose real path (symlinked folders and `../` resolved) is outside the working
   directory carries no check and is never read. A verified call
   is closed with `resolve how: "verified"` and named, not redone. Every other tool that is not
   read-only (commands, terminals, MCP, the desktop, extensions) carries no check: always asked,
   never redone. A call from another build is named before any retry is offered.
   Headless `8gent -p --resume <id>` (or `--session`, `--continue`) never prompts: it prints the
   open calls on stderr and exits 3, unless `--durable-retry` (open writes go to 8gent as a
   check-then-redo preamble; the retry run is an allowlist, read-only tools plus `write_file`,
   `edit_file` and `git_commit`, so every other tool is not offered and is refused before it
   runs, `run_batch` included, and `--yes` cannot re-run a command) or `--durable-skip`. A `-p --durable` run
   prints its session id, so a run killed before it saved can still be resumed by its ledger.
   Test: `durable-verify.test.ts`.
4. Default on: done in slice 2 for the TUI (Pi parity). Headless default stays off.

## Not doing

Heap or process snapshots. Automatic replay of any non-read-only tool. Copying arguments or
results into the ledger. A second session store.
