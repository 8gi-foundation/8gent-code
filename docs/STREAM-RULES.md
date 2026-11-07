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
