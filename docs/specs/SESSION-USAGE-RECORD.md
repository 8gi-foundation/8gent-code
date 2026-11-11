# Session usage record

One local file per session, so the context and limit use of every session can be listed with no model call and no network request. Refs #222, slice 1 (viewing only).

## Where

`<data dir>/session-usage/<session>.json`, where the data dir is `EIGHT_DATA_DIR` or `~/.8gent`. Overwritten in place by writing a temp file and renaming it. Nothing runs in the background; a record is written only when a reader is invoked.

## Fields

| Field | Type | Meaning |
|---|---|---|
| `version` | `1` | Format version |
| `session` | string | Session name |
| `workspace` | string or null | Folder name of the project |
| `harness` | string or null | Which engineering harness the session runs |
| `account` | string or null | A label the user sets. Never a credential |
| `contextUsed` | number or null | Tokens in context |
| `contextWindow` | number or null | Window size in tokens |
| `usagePct` | number or null | Percent (0-100) of the account limit used, null when the harness does not report it |
| `updatedAt` | ISO 8601 string | When the reader last wrote the record |

A number the harness did not report is `null` and is shown as `unknown`. It is never guessed and never zero.

## Staleness

The view marks a record stale when `updatedAt` is older than 5 minutes. The record itself is not changed.

## Reader for a harness whose status line passes JSON on stdin

```
<status line command> | bun packages/session-usage/statusline.ts --harness <name> --account <label> [--session <name>]
```

It reads `session_id`, `cwd`, `workspace`, `context_window.context_window_size`, `context_window.used_percentage` or `total_input_tokens`, and `rate_limits.*.used_percentage` (highest window wins), if present. It makes no model call and no network request, and it never fails the status line it sits in.

## List

```
bun packages/session-usage/index.ts
```

Sorted by nearest limit, unknown last, then by context fill.

## Adding a harness

Write a reader that fills these fields and calls `writeRecord`. The view needs no change.
