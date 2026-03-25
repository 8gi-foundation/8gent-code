# metric-collector

**Status:** quarantine

## Description

Runtime metric collection for agent observability. Provides counter, gauge, and histogram primitives with label support and dual export formats (JSON and Prometheus text).

## Capabilities

- **Counter** - monotonically increasing values, supports `inc(labels, amount)`
- **Gauge** - arbitrary numeric values, supports `set`, `inc`, `dec` with labels
- **Histogram** - distribution tracking over configurable upper-bound buckets, tracks `sum`, `count`, per-bucket cumulative counts
- **Labels** - all metric types accept a `Record<string, string>` labels map for multi-dimensional aggregation
- **Export JSON** - `collector.toJSON()` returns structured object for logging or storage
- **Export Prometheus** - `collector.toPrometheus()` emits valid Prometheus text format for scraping

## Usage

```ts
import { MetricCollector } from "./packages/tools/metric-collector";

const metrics = new MetricCollector();

// Counter
const requests = metrics.counter("http_requests_total", "Total HTTP requests");
requests.inc({ method: "GET", status: "200" });

// Gauge
const activeConns = metrics.gauge("active_connections", "Open connections");
activeConns.set(42);
activeConns.dec();

// Histogram
const latency = metrics.histogram("request_duration_seconds", "Request latency", [0.1, 0.5, 1, 5]);
latency.observe(0.32, { route: "/api/agent" });

// Export
console.log(metrics.toPrometheus());
console.log(JSON.stringify(metrics.toJSON(), null, 2));
```

## Integration Path

1. **Agent observability** - wire into `packages/eight/agent.ts` to track tool call counts, token usage, and latency histograms per session
2. **Daemon metrics endpoint** - expose `GET /metrics` from `packages/daemon/` returning `toPrometheus()` output for Prometheus scraping on Fly.io
3. **Benchmark harness** - replace ad-hoc counters in `benchmarks/autoresearch/` with typed gauge/counter calls for consistent reporting
4. **Memory health** - add gauge for SQLite row counts and FTS5 index size in `packages/memory/health.ts`

## Files

| File | Purpose |
|------|---------|
| `packages/tools/metric-collector.ts` | Implementation - Counter, Gauge, Histogram, MetricCollector |
| `quarantine/metric-collector.md` | This spec |

## Promotion Criteria

- [ ] Unit tests covering all three metric types and label permutations
- [ ] Integration in at least one package (daemon or agent loop)
- [ ] Prometheus scrape verified against a real Prometheus instance or `promtool check metrics`
