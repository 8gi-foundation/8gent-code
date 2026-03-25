# Quarantine: Cost Tracker

## What

Token usage tracking and budget alerting for LLM calls. Tracks per-model input/output tokens, estimates USD cost from a pricing table, generates daily/weekly reports, and fires alerts at configurable budget thresholds.

## File

`packages/proactive/cost-tracker.ts` (~130 lines)

## API

- `CostTracker.record(entry)` - log a completed LLM call, returns a `BudgetAlert` if approaching limits
- `CostTracker.report('daily' | 'weekly')` - generate a cost breakdown by model for the period
- `CostTracker.estimateCost(entry)` - estimate USD for a single call
- `CostTracker.setPricing(model, input, output)` - update per-1M-token pricing
- `CostTracker.loadEntries(entries)` / `getEntries()` - persistence hooks

## Budget Alerts

| Threshold | Level |
|-----------|-------|
| Daily >= 90% | critical |
| Daily >= 70% | warning |
| Weekly >= 80% | warning |

Defaults: $5/day, $25/week. Configurable via constructor.

## Models Covered

Pricing table includes OpenRouter free/paid models and local Ollama (zero cost). Use `setPricing()` to add or update models at runtime.

## Integration Path

1. Wire into `packages/eight/agent.ts` after each LLM call
2. Persist entries to `.8gent/cost-history.json` or SQLite
3. Surface alerts in TUI status bar
4. Add `/cost` command to show report

## Exit Criteria

- [ ] Unit tests for cost calculation and budget alerts
- [ ] Wired into agent loop
- [ ] Persistence layer chosen and implemented
- [ ] TUI integration for reports and alerts
