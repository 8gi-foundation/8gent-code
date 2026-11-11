# Session usage record

One local file per session, so the context and limit use of every session can be listed with no model call and no network request. Refs #222, slice 1 (viewing only).

## Where

`<data dir>/session-usage/<name>.json`, where the data dir is `EIGHT_DATA_DIR` or `~/.8gent`. `<name>` is the session name when it is 1 to 120 characters of `A-Z a-z 0-9 . _ -`. Otherwise every other character becomes `_`, the result is cut to 120 characters (`unnamed` if empty), and `-` plus the first 8 hex characters of the SHA-256 of the original session name is added, so two different sessions never share a file. Overwritten in place by writing a temp file and renaming it. Nothing runs in the background; a record is written only when a reader is invoked.

## Permissions and writing

- The records folder is created with mode `0o700` and each record file with mode `0o600` (the process umask can only narrow these). Records hold session names, project folder names and the account label, so they are private to the user.
- If the records folder already exists, it is used as it is. Its mode is not changed (not widened, not narrowed) and the write is not refused. A user who wants it private sets the mode once.
- The temp file is `<record>.<pid>.tmp`, created exclusively (`wx`, mode `0o600`). If anything already exists at that name the write fails with an error and the existing entry is left untouched. If the write or rename fails after the temp file was created, the temp file is removed. The status line reader swallows the error, so the session it sits in is never broken.

## Fields

| Field | Type | Meaning |
|---|---|---|
| `version` | `1` | Format version |
| `session` | string | Session name as given (the file name is derived, see Where). Kept to the first 200 characters when read |
| `workspace` | string or null | Folder name of the project |
| `harness` | string or null | Which engineering harness the session runs |
| `account` | string or null | A label the user sets. Never a credential |
| `contextUsed` | number or null | Tokens in context |
| `contextWindow` | number or null | Window size in tokens |
| `usagePct` | number or null | Percent (0-100) of the account limit used, null when the harness does not report it |
| `updatedAt` | ISO 8601 string | When the reader last wrote the record |

A number the harness did not report is `null` and is shown as `unknown`. It is never guessed and never zero.

## Reading

Each entry in the folder ending in `.json` is checked with `lstat` first. Anything that is not a regular file (a folder, a link, a pipe) or is larger than 64 KB (65536 bytes) is skipped. Files that are not valid records are skipped.

## Printing

Every string printed to a terminal (the list, and the line the status line reader prints) has C0 (U+0000-U+001F), DEL (U+007F) and C1 (U+0080-U+009F) control characters replaced with `?`, and is cut to 120 characters. The stored value is not changed.

## Limits

| Limit | Value |
|---|---|
| Record file read | 64 KB (65536 bytes) |
| Session name kept on read | 200 characters |
| Session name in the file name | 120 characters of `[A-Za-z0-9._-]`, plus `-` and 8 hex characters when changed |
| Printed string | 120 characters |
| Folder mode / file mode | `0o700` / `0o600` |

## Staleness

The view marks a record stale when `updatedAt` is older than 5 minutes. The record itself is not changed.

## Reader for a harness whose status line passes JSON on stdin

The harness writes its JSON to the stdin of its status line command, and shows that command's stdout as the status text. So the reader is run as the status line command:

```
bun packages/session-usage/statusline.ts --harness <name> --account <label> [--session <name>]
```

It prints the session name, which is what the person sees as the status text. To keep an existing status line, use a small wrapper that keeps a copy of stdin, hands one copy to the reader with its output discarded, and the other to the existing command.

Piping the output of a status line command into the reader does not work: the reader would get text, not JSON, and write nothing.

Fields read, if present:

- `session`: `--session`, else `session_id`. No session means no record.
- `workspace`: the last path part of `workspace.project_dir`, else `workspace.current_dir`, else `cwd`.
- `harness`: `--harness`.
- `account`: `--account`, else the `EIGHT_ACCOUNT_LABEL` environment variable.
- `contextWindow`: `context_window.context_window_size`.
- `contextUsed`: when `context_window.used_percentage` and a window size above 0 are both reported, the percentage times the window, rounded. Otherwise `context_window.total_input_tokens`. Otherwise null.
- `usagePct`: the highest `used_percentage` among the `rate_limits.*` windows, else null.

The reader makes no model call and no network request, and it never fails the status line it sits in: any error is swallowed.

## List

```
bun packages/session-usage/index.ts
```

Sorted by nearest limit, unknown last, then by context fill.

## Adding a harness

Write a reader that fills these fields and calls `writeRecord`. The view needs no change.
