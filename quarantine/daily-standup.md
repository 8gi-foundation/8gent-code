# Daily Standup Generator

## Problem

No automated daily summary of what happened in the repo. Manual standups are tedious and often skipped.

## Constraint

Must work with zero config - just run it from the repo root. No API keys required (uses `gh` CLI for PRs).

## Not doing

- Slack/Telegram delivery (that is a separate integration layer)
- AI summarization of commits (plain commit messages are fine for now)
- Multi-repo aggregation

## Design

### Data sources

1. **Git log** - commits from the last N hours (default 24), deduplicated
2. **Git diff** - detects uncommitted work in the working tree
3. **GitHub PRs** - open PRs via `gh pr list`, split into draft (in-progress) and non-draft (awaiting review)

### Output format

Three sections matching standard standup format:

- **DONE** - committed work (commit messages)
- **IN PROGRESS** - draft PRs + uncommitted changes
- **BLOCKED** - non-draft PRs awaiting review (heuristic: if a PR is open and not draft, it is waiting on someone)

Plus a stats line: commit count, files changed, open PR count.

### Usage

```bash
# Default: last 24 hours, text output
bun run packages/proactive/standup-generator.ts

# JSON output for piping to Telegram/Slack
bun run packages/proactive/standup-generator.ts --json

# Custom time window
bun run packages/proactive/standup-generator.ts --hours 48
```

### Cron integration

Add to crontab for 9am daily:

```
0 9 * * * cd /path/to/8gent-code && bun run packages/proactive/standup-generator.ts >> ~/.8gent/standup.log
```

Or pipe JSON to a webhook:

```
0 9 * * * cd /path/to/8gent-code && bun run packages/proactive/standup-generator.ts --json | curl -X POST -H 'Content-Type: application/json' -d @- https://hooks.slack.com/...
```

### Success metric

Running `bun run packages/proactive/standup-generator.ts` produces a readable standup summary with zero configuration.

### Files

| File | Lines | Purpose |
|------|-------|---------|
| `packages/proactive/standup-generator.ts` | ~120 | Generator + CLI |
| `quarantine/daily-standup.md` | this file | Design doc |

### Future

- Telegram/Slack delivery via existing bot infrastructure
- AI-powered commit grouping (cluster related commits into themes)
- Multi-repo support for the full 8gent ecosystem
