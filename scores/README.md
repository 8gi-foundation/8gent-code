# scores/

The public benchmark ledger for the frontier gate (issue #2758).

`ledger.json` holds one entry per benchmark category: the average score
from the most recent trusted `benchmark:v2` run and how many benchmarks
fed that average. It starts empty on purpose - no category is seeded with
a guessed or hand-typed number. The first real run that passes
`--update` (nightly, on the forge Mac, or any run a maintainer trusts)
writes the first baseline for each category it covers.

## How it grows

```bash
# Grade a fresh run against the current ledger, print a report, exit 1 on regression.
bun run benchmark:gate

# Same, but also write this run's averages into the ledger (nightly/trusted runs only).
bun run benchmark:gate:update
```

`benchmarks/gate.ts` is the only writer. See `benchmarks/gate.test.ts` for
the regression/bootstrap/stable behavior this file's shape guarantees.

## Why this file is checked in and not generated on the fly

The ledger is the "no regression ships" contract from #2758: every PR that
touches `packages/eight`, `packages/providers`, or `packages/tools` is
graded against the last trusted numbers in this file, in-repo, in the diff
- not against a number nobody can see.
