# file-size-tracker

**Tool name:** file-size-tracker
**Package path:** `packages/tools/file-size-tracker.ts`
**Status:** quarantine

## Description

Scans a directory, records file sizes into a baseline snapshot, and compares future scans against that baseline to detect bloat. Flags files that exceed a configurable growth threshold (default 10 KB delta), reports shrinkage and new/removed files, and generates a human-readable summary report.

Exports three functions: `trackSizes(dir)`, `compareBaseline(dir, baseline)`, `generateReport(dir, deltas, baseline)`.

## Integration path

1. Import from `packages/tools/file-size-tracker.ts`.
2. Call `trackSizes(dir)` and persist the returned `SizeBaseline` JSON to disk (e.g. `.8gent/size-baseline.json`).
3. On subsequent runs, load the baseline and call `compareBaseline(dir, baseline, { thresholdBytes: 20_000 })` to get deltas.
4. Pass deltas to `generateReport()` to get the structured report with a `summary` string.
5. Wire into `packages/validation/` or a CI script to fail builds when flagged growth exceeds a budget.

## Example

```ts
import { trackSizes, compareBaseline, generateReport } from "../packages/tools/file-size-tracker.ts";
import { writeFileSync, readFileSync } from "fs";

const BASELINE_PATH = ".8gent/size-baseline.json";

// Record baseline
const baseline = trackSizes("packages/");
writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2));

// Later: compare and report
const saved = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
const deltas = compareBaseline("packages/", saved, { thresholdBytes: 15_000 });
const report = generateReport("packages/", deltas, saved);
console.log(report.summary);
// File Size Report — packages/
// Baseline: 412.3 KB  Current: 438.1 KB  Delta: +25.8 KB
// Flagged (1):
//   [GROWTH] tools/some-new-tool.ts  +18.2 KB (120%)
```
