# scores/

The public benchmark ledger for the frontier gate (issue #2758).

`ledger.json` holds two things, both from the most recent trusted
`benchmark:v2` run:

- `categories` - one entry per benchmark category: the blended average
  score across every model that ran it, and how many benchmarks fed that
  average. This is what the CI gate compares against to hard-fail a
  regression (step 1).
- `models` - the same average score, but broken out per `model -> category`
  pair, so a router change or an `eight-1.0` checkpoint bump is attributable
  to the model that produced it instead of hiding inside a blended number
  (step 4). Purely informational - it is never used to fail a build.

Both start empty on purpose - no category or model is seeded with a
guessed or hand-typed number. The first real run that passes `--update`
(nightly, on the forge Mac, or any run a maintainer trusts) writes the
first baseline for each category and model it covers.

## How it grows

```bash
# Grade a fresh run against the current ledger, print a report (with a
# per-model attribution table), exit 1 on category regression.
bun run benchmark:gate

# Same, but also write this run's category + per-model averages into the
# ledger (nightly/trusted runs only).
bun run benchmark:gate:update

# Hide the per-model attribution table, just the category-level report.
bun run benchmark:gate -- --no-by-model
```

`benchmarks/gate.ts` is the only writer. See `benchmarks/gate.test.ts` for
the regression/bootstrap/stable behavior this file's shape guarantees, for
both the blended category numbers and the per-model breakdown.

## Why this file is checked in and not generated on the fly

The ledger is the "no regression ships" contract from #2758: every PR that
touches `packages/eight`, `packages/providers`, or `packages/tools` is
graded against the last trusted numbers in this file, in-repo, in the diff
- not against a number nobody can see.
