# Control tab: your running loops

`/control` (alias `/loops`) lists every loop you have going: what it is doing, when it last ran, when it runs next, and what it is waiting on from you. Nothing leaves your machine; the tab only reads files in your own home folder.

Each loop reports itself by writing one small file in `~/.8gent/jobs/`. 8gent writes these for its own loops:

| Kind | Name | When it writes |
|------|------|----------------|
| `cron` | `cron-<job name>` | A durable scheduled job starts, finishes, or fails. A failed job waits on you. |
| `helper` | `helper-<id>` | A background helper run is queued, starts, finishes, fails or is cancelled. |
| `update` | `update-check` | The opt-in update check runs (once a day at most). |

Files are written only when something happens, never on a timer. 8gent clears only its own finished helper files (`helper-*.json`), a day after they end, the next time a helper starts. Your files, and the cron and update files, are never deleted.

## Report from your own script

Write `~/.8gent/jobs/<name>.json`, one file per loop:

```json
{
  "kind": "nightly",
  "name": "backup",
  "state": "running",
  "stage": "copying photos",
  "last": "2026-10-25T02:00:00",
  "next": "2026-10-26T02:00:00",
  "waitingOn": null,
  "detail": "12 of 40 folders"
}
```

| Field | Meaning |
|-------|---------|
| `state` | Required. One of `running`, `queued`, `waiting-on-you`, `stalled`, `done`. A `done` row is not listed. |
| `kind` | A short group label. Defaults to `loop`. |
| `name` | The row title. Defaults to the file name. |
| `stage` | What it is doing now, a few words. |
| `last`, `next` | An ISO time (shown as HH:MM), epoch milliseconds, or any short text such as `after the next release`. |
| `waitingOn` | What you need to do, when `state` is `waiting-on-you`. |
| `detail` | One line of extra context. |

Update the file whenever the state changes, and write `done` when the loop ends. A `running` row whose file has not been touched for 60 minutes (set `staleAfterMin` in the file to change it, or in `~/.8gent/control.json`) is shown as `stalled`.

Write the file atomically so the tab never reads half of it: write to a temporary name in the same folder, then rename it over the real one.

```sh
f="$HOME/.8gent/jobs/backup.json"
mkdir -p "$(dirname "$f")"
printf '{"kind":"nightly","name":"backup","state":"done","stage":"finished"}\n' > "$f.tmp" && mv "$f.tmp" "$f"
```

To read jobs from a different folder, point the reader at it in `~/.8gent/control.json`:

```json
{ "sources": [{ "type": "jobs", "dir": "~/my-loops" }] }
```

Set `EIGHT_JOBS_DIR` to make 8gent write its own files to that folder instead.
