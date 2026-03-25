# Usage Analytics Dashboard

## Status: Quarantine

Standalone HTML dashboard for visualizing 8gent session analytics.

## What it does

- Displays daily token usage (input vs output) as a stacked bar chart
- Shows model distribution across sessions as a doughnut chart
- Shows tool usage frequency as a horizontal bar chart with detail table
- Summary stat cards: total tokens, sessions, avg tokens/session, models used

## Tech

- Chart.js 4.x via CDN
- No build step - single HTML file, embeddable in dashboard app
- Mock data structure matches session-analytics output format
- Dark theme using brand tokens from BRAND.md

## Files

- `apps/dashboard/src/UsageAnalytics.html` - the dashboard page

## To promote

1. Wire real data from session-analytics / memory store
2. Add date range picker
3. Integrate into `apps/dashboard/` build pipeline
4. Add cost estimation per model (if applicable)

## Data shape

The mock data mirrors the expected session-analytics output:

```ts
{
  period: { start: string, end: string },
  summary: { totalTokens, totalSessions, avgTokensPerSession, modelsUsed },
  dailyTokens: Array<{ date, input, output }>,
  modelDistribution: Array<{ model, sessions, tokens }>,
  toolUsage: Array<{ tool, calls }>
}
```
