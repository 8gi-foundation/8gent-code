# @8gi-foundation/golden

Golden test sets and measurement baselines for the 8gent agent.

> "We are giving these autonomous agents a lot of power and we're not really
> measuring them if we're not disciplined." - Nate B Jones
>
> "You can't optimize what you don't measure." - Rob Pike, Rule 1

This package wires the discipline. Every release runs a curated set of
deterministic prompts against the daemon's `AgentPool`, captures the
response, tool calls, and wall-clock latency, grades each run against
the case's declared expectations, and writes a structured artifact you
can diff against any prior run.

## Structure

```
packages/golden/
├── schema.ts        Zod schema for golden cases + result types
├── grader.ts        Deterministic grading (substrings, regex, tools, latency, length)
├── runner.ts        Suite runner + AgentPool transport adapter
├── store.ts         JSONL persistence, latest-pointer, run diff
├── cli.ts           bun entry point
├── cases/           One JSON file per golden case
└── __tests__/       bun:test coverage for the grader + runner
```

## Run

```bash
# Live - hits the daemon's AgentPool with the configured runtime/model
bun run test:golden

# Dry run - no model calls, exercises the load/grade/store pipeline
bun run test:golden:dry

# Subset (regex match against case id)
bun run packages/golden/cli.ts --filter '^code-'

# Diff against a prior run
bun run packages/golden/cli.ts --diff golden-2026-05-08T12-00-00-000Z-abc123
```

Results live under `$EIGHT_DATA_DIR/golden/runs/<runId>/` (default
`~/.8gent/golden/runs/`). Each run writes:

| File           | Contents                                  |
| -------------- | ----------------------------------------- |
| `summary.json` | aggregate metrics for diffs               |
| `cases.jsonl`  | one line per case, full grade + transport |
| `latest.json`  | pointer to the most recent run            |

## Authoring a case

A case is a JSON file in `cases/` with this shape:

```json
{
  "id": "kebab-case-id",
  "title": "Human-readable title",
  "tags": ["category", "tag2"],
  "prompt": "What you send to the agent.",
  "expect": {
    "substrings": [{ "value": "expected text", "mode": "present" }],
    "regexes": [{ "pattern": "regex pattern", "flags": "i" }],
    "tools": { "required": ["bash"], "forbidden": ["delete"] },
    "latency": { "wallMs": 30000 },
    "minLength": 10,
    "maxLength": 5000
  }
}
```

Validation runs at load time via Zod. Bad shape = hard error, not a
silent skip.

### Authoring rules

- **Deterministic.** A case must produce the same outcome on the same
  model. If it depends on tool side effects (file system, network), the
  expected substrings/regexes must capture only the determinate parts
  of the response.
- **Strict checks.** `mode: "missing"` substrings are first-class -
  use them for refusal cases (e.g. "must not leak `sk-` API keys").
- **Realistic latency budgets.** Cap `wallMs` at the slowest acceptable
  end-to-end, not the median.
- **Don't grade vibes.** No "should be helpful" checks. Every check
  must be machine-verifiable.

## Transport

The default transport adapter wraps `packages/daemon/agent-pool.ts`. It
creates a fresh session per case, captures `tool:start`/`tool:result`
events from the daemon `EventBus`, and tears down the session on
completion. This means golden runs exercise the same code path as
production traffic from Telegram, the TUI, or the web app.

For local development without a model server, use `--dry-run`. It
swaps in a stub transport that echoes the prompt and emits zero tool
calls - good enough to sanity-check the case pipeline.

## Exit codes

| Code | Meaning                              |
| ---- | ------------------------------------ |
| 0    | All cases passed                     |
| 1    | At least one case failed             |
| 2    | Transport init failed before any run |

CI should treat exit code 1 as a regression. Exit code 2 is a setup
problem - usually a missing `OLLAMA_HOST` or downed daemon.
