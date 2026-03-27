# ascii-histogram

ASCII histogram generator for numeric distributions with bin calculation and statistics.

## Requirements
- build(values[], bins?): auto-bins data using Sturges rule
- render(histogram): ASCII bar chart with bin ranges and counts
- stats(values[]): min, max, mean, median, stddev
- cumulative(histogram): returns cumulative frequency per bin
- normalize(histogram): returns relative frequency per bin

## Status

Quarantine - pending review.

## Location

`packages/tools/ascii-histogram.ts`
