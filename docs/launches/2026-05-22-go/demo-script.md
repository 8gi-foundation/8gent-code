# /go Downloads-folder demo - reproducible in 60 seconds

**Goal:** a stranger with an M-series Mac runs this in under 60 seconds and gets the same result you saw in the launch video.

**Status:** primary public demo for the 2026-05-22 launch.

---

## The prompt (ONE LINE, paste-ready)

```
/go organize my Downloads folder by file type and date, dedupe, surface anything sketchy.
```

That is the entire demo. One slash command, one line, no flags, no setup files.

---

## System requirements

You need ONE of the following local stacks. The /go judge will pick whichever is available, in this order.

1. **macOS 26 on Apple Silicon** (apfel auto-enabled - zero setup, fastest).
2. **Ollama** running locally with at least one chat model and one judge model pulled:
   ```
   ollama pull qwen3:14b
   ollama pull llama3.2:3b
   ```
3. **LM Studio** running locally with the local server enabled and at least one model loaded.

If none of the above is available the run halts at start with a clear message and an install link. It will never silently fall back to cloud.

Disk: ~200MB free in your home for the run ledger.
RAM: 16GB minimum, 32GB recommended for a clean judge pass on Ollama.

---

## 60-second walkthrough

```bash
# 0:00  install (skip if already installed)
npm i -g @8gi-foundation/8gent-code

# 0:10  launch the TUI
8gent

# 0:15  paste the prompt
/go organize my Downloads folder by file type and date, dedupe, surface anything sketchy.

# 0:20  watch the LiveFocalStrip
#       you should see one-line status updates:
#         scanning - 247 files
#         planning - 6 categories detected
#         sub-agent - dedupe pass
#         judge - apfel - checking
#         done

# 0:55  open ~/Downloads in Finder
#       confirm new folders, dupes removed, Surface/ folder populated.
```

If you don't have 247 files in Downloads it still works. The demo scales to whatever you have.

---

## Expected output shape

**File system changes inside `~/Downloads`:**

```
~/Downloads/
  Images/
    2026/
      2026-04/
      2026-05/
    2025/
  PDFs/
    2026/
    2025/
  Archives/
  Code/
  Installers/
  Documents/
  Surface/                    <- anything the model flagged for your eyes
  _Originals_2026-05-22/      <- safety mirror, untouched, for 24h
```

**Verdict card in the TUI (locked copy from `packages/eight/go/verdicts.ts`):**

```
Done. 247 organized. 41 deduped. 3 flagged.
Receipt: ~/.8gent/runs/{run-id}/ledger.jsonl
```

**What "sketchy" surfaces:**

- Unsigned installers (`.dmg`, `.pkg` without notarization).
- Executables you don't typically run (`.exe`, `.bat`, `.sh` from unknown origins).
- Files with mismatched extensions (e.g. a `.pdf` that is actually a script).
- Recent files from senders flagged in your existing Mail or Messages threads (if Mail/Messages access granted; otherwise skipped silently).

It moves them. It does not delete them. The `_Originals_2026-05-22/` mirror is your undo.

---

## Anti-script - graceful degradation

If the local judge is unavailable mid-run, the user sees this, exactly:

```
Local judge unavailable.
This run is paused, not failed.
Resume with cloud judge (opt-in, your keys):  /go resume --cloud-judge
Resume when local is back:                    /go resume
Abort and keep what changed:                  /go stop
Abort and roll back:                          /go stop --rollback
```

What this is NOT:

- It is not "successfully paused while we contact the cloud."
- It is not a silent cloud fallback.
- It is not a dialog box. It is one card in the TUI, one chord to continue.

The local judge "unavailable" condition is determined deterministically (apfel binary missing, Ollama HTTP 503, LM Studio port closed). It is not "the judge took too long" - timeouts trigger a different verdict ("Needs you").

---

## Reset script (for repeat demos)

```bash
# Restore the test folder from the safety mirror
mv ~/Downloads/_Originals_2026-05-22/* ~/Downloads/
rm -rf ~/Downloads/_Originals_2026-05-22

# Optional: clear the run ledger for a clean recording
rm -rf ~/.8gent/runs/
```

The safety mirror is auto-purged after 24 hours unless `8gent settings set go.safetyMirrorTTL` is changed.

---

## Verification commands (for the demo presenter)

```bash
# Confirm local judge actually ran (no cloud fallback)
grep -l '"judge_provider":"cloud"' ~/.8gent/runs/*/ledger.jsonl
# Empty output = local-only. That is what we want.

# Confirm the verdict matches the locked copy
tail -1 ~/.8gent/runs/$(ls -t ~/.8gent/runs | head -1)/ledger.jsonl | jq .verdict

# Confirm hash chain is intact
8gent ledger verify $(ls -t ~/.8gent/runs | head -1)
```

If `grep` returns anything, the demo was tainted by cloud. Discard the take and re-run with wifi off.

---

## Backup demo (AIDHD essay companion)

```
/go triage my inbox by importance and draft replies.
```

Same shape. Different surface. Pulls from Mail.app via system Mail access (must be granted on first run via standard macOS prompt). Produces:

- Inbox sorted into `Now / Today / This week / Later / Trash candidate`.
- Draft replies saved as Mail drafts (never sent automatically).
- Surface card for anything that looks like phishing, a deadline you missed, or a chase from someone you owe.

Run length: 2 to 8 minutes depending on inbox size. Local judge runs the whole way.

---

## What the demo proves

1. One slash command produces a real, useful, visible result.
2. Wifi can be off the whole time.
3. The model picker shows local options only.
4. The receipt on disk is hash-chained, signed, replayable.
5. The verdict copy is short and doesn't sound like an AI assistant.

If any of those five fail, the launch is not ready. Re-test.
