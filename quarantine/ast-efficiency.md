# Quarantine: AST Efficiency Report Generator

## What

`packages/proactive/ast-efficiency-report.ts` - a report generator that reads AST-first code exploration metrics and produces weekly efficiency reports.

## Why

The AST-first protocol (CLAUDE.md) mandates using jcodemunch outlines and symbol fetches instead of full file reads. This report measures compliance and identifies where tokens are being wasted.

## What it does

- Reads `~/.claude/research/ast-efficiency-metrics.jsonl` (logged by PreToolUse hook)
- Calculates: tokens consumed vs saveable, AST-eligible read percentage
- Ranks files by waste (tokens that could have been saved via AST)
- Ranks files by query frequency (candidates for persistent indexing)
- Breaks down efficiency per session
- Generates actionable recommendations

## Usage

```bash
# Default: last 7 days
bun run packages/proactive/ast-efficiency-report.ts

# Custom window
bun run packages/proactive/ast-efficiency-report.ts 30
```

## Findings from first run (30-day window)

- 8,597 total file reads tracked
- 74% of reads were AST-eligible (should have used outline + symbol fetch)
- 46% of all tokens consumed were saveable via AST
- `apps/tui/src/app.tsx` alone wasted 6.2M tokens across 360 reads
- Top 10 files account for the majority of waste

## Integration path

1. Wire into a weekly cron or post-session hook
2. Could feed recommendations back into agent system prompt
3. Could auto-index the top wasteful files at session start

## Files

- `packages/proactive/ast-efficiency-report.ts` (~190 lines)

## Risk

None. Read-only analysis. Does not modify any existing files or systems.
