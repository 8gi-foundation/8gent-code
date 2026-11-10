# Stream rules

Off by default. Nothing is installed; copy the example yourself if you want it:

    cp docs/examples/stream-rules.example.json ~/.8gent/stream-rules.json

Each rule is `{ "pattern": regex, "correction": one line, "max_retries": 1 }`.
Patterns are JavaScript regular expressions (no inline flags).
While a reply streams (text-tool path), if the text so far matches a pattern,
that generation is aborted, the correction is appended as a system note and the
step is retried once. At most one retry per turn; the retry is not checked again.
Rules with a bad regex, a multi-line correction or `max_retries` other than 1 are
skipped. A JSON-only (non-streamed) reply is not checked. With no file, nothing changes.

Limits, so a rule cannot hang a reply:

- Each check sees a bounded tail: the new piece of text (at most 2048 characters
  of it) plus the 256 characters before it. A pattern that needs more context
  than that will not match.
- All checks on one reply share a 100 ms budget. Past it, the rest of that reply
  goes unchecked.
- A pattern with a quantified group that itself holds a quantifier, like
  `(a+)+`, is skipped: that shape backtracks exponentially.

The aborted draft is not kept. Only the corrected reply reaches the durable turn.

The file is read from the 8gent data dir (`$EIGHT_DATA_DIR`, else
`$EIGHT_HOME/.8gent`, else `~/.8gent`). Because it adds a system note to future
turns, it is protected like `hooks.yaml` and `yolo.json`: a `run_command` or a
file tool cannot write, replace or remove it. Edit it yourself, outside 8gent.
