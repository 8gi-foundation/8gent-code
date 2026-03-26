# metrics-collector

In-process metrics collector (counters, gauges, histograms).

## Requirements
- counter(name) increments count
- gauge(name, value) sets current value
- histogram(name, value) records observation
- getAll() returns snapshot
- reset() clears all metrics

## Status

Quarantine - pending review.

## Location

`packages/tools/metrics-collector.ts`
