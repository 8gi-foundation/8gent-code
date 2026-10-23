# Durable turns

Status: slice 1 built (intent and effect ledger, resume report, retry or skip). Owner: 8TO.

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

## Design

### The ledger

One append-only JSONL file per session, `~/.8gent/sessions/durable/<session id>.jsonl`, keyed by
the same id `8gent --resume` takes (the tree store id). Records:

| `k` | Written | Fields |
| --- | --- | --- |
| `turn` | A person's message starts a turn | `at` |
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

Durable is a mode of the same 8gent-code, not a fork. Off by default in slice 1.

- `8gent --durable` (and `8gent --durable --resume`) turns it on for the run.
- `EIGHT_DURABLE=1` is the persistent setting.
- `/durable` toggles it; `/durable on|off` sets it.
- The footer shows `durable on` while it is on.

**How it becomes the default.** When slices 1 to 3 have each passed three recorded runs on
Artale's Android (kill mid-write, kill mid-model-call, 4G drop mid-stream), the default flips to
on with `EIGHT_DURABLE=0` as the opt-out, in a release whose notes name the change. The gate is
those recordings, not a date.

## Slices

1. **Built.** Intent and effect for every tool call in the native, text-tool and `run_batch`
   loops (one tap in `SessionWriter.write`), the resume report, `/durable retry|skip`, the
   `--durable` flag, the footer segment. Test: `durable-ledger.test.ts` SIGKILLs a real child
   process between a write's intent and its effect, then resumes and asserts the write happened
   once and the person is asked.
2. A turn cut off with no tool open (killed while waiting on the model, or a 4G drop
   mid-stream): `turn_end` records, and resume offers to resend the person's last message. A turn
   summary file written temp-then-rename, so the model resumes from the summary.
3. Build signature in the ledger header; idempotency keys passed to tools that can honour them
   (`git_commit` checks for the commit, `write_file` compares the content hash); headless
   `8gent -p` resume.
4. Default on, per the gate above.

## Not doing

Heap or process snapshots. Automatic replay of any non-read-only tool. Copying arguments or
results into the ledger. A second session store.
