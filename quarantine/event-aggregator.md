# event-aggregator

**Tool name:** EventAggregator

**Description:**
Time-window analytics for agent events. Records named events with optional numeric values and provides count, sum, avg, rate, and topN queries over configurable windows (1m, 5m, 1h, 1d). Designed for lightweight in-process observability - no external dependencies, no persistence.

**Status:** quarantine

**Location:** `packages/tools/event-aggregator.ts`

**Exports:**
- `EventAggregator` class
- `TimeWindow` type (`"1m" | "5m" | "1h" | "1d"`)

**API surface:**
| Method | Signature | Description |
|--------|-----------|-------------|
| `record` | `(event, value?)` | Record an occurrence; value defaults to 1 |
| `count` | `(event, window)` | Occurrences in window |
| `sum` | `(event, window)` | Sum of values in window |
| `avg` | `(event, window)` | Average value in window |
| `rate` | `(event, window)` | Occurrences per second over window |
| `topN` | `(n, window)` | Top N events by count, descending |
| `snapshot` | `(window)` | All events with counts for window |
| `reset` | `()` | Clear all data |

**Integration path:**
1. Import into `packages/eight/agent.ts` or any tool package.
2. Instantiate once per session: `const agg = new EventAggregator()`.
3. Call `agg.record("tool:bash")` at each tool invocation.
4. Surface `agg.topN(5, "1h")` in the debugger or activity monitor panel.
5. Optionally persist snapshot to `.8gent/analytics.json` on session end.

**Promotion criteria:**
- [ ] Wired into agent loop with at least 5 tracked event types
- [ ] topN surfaced in the activity monitor or debugger
- [ ] Snapshot persisted to disk on session end
- [ ] No regressions in existing tool tests
