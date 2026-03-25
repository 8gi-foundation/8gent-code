# Quarantine: data-pipeline

## Status
Quarantined - pending review before integration into core toolchain.

## What it is
ETL-style composable data pipeline with per-stage error handling and stats tracking.

## File
`packages/tools/data-pipeline.ts`

## API

```ts
import { Pipeline } from './packages/tools/data-pipeline';

const stats = await new Pipeline<RawRow>({ continueOnError: true })
  .extract(() => fetchRows())
  .transform(row => normalize(row))
  .filter(row => row.active)
  .validate(row => row.id != null || 'Missing id')
  .load(rows => db.insertAll(rows))
  .run();

console.log(stats); // { extracted, transformed, filtered, validated, loaded, errors[], durationMs }
```

## Stages
| Stage | Method | Purpose |
|-------|--------|---------|
| Extract | `.extract(source)` | Pull items from array or async function |
| Transform | `.transform(fn)` | Map each item, returns new typed pipeline |
| Filter | `.filter(pred)` | Keep items matching predicate |
| Validate | `.validate(schema)` | Reject items failing validation, collect errors |
| Load | `.load(dest)` | Write final items to destination |

## Error handling
- Per-stage errors captured in `stats.errors[]`
- `continueOnError: true` (default) - bad items are dropped, pipeline continues
- `continueOnError: false` - first error throws and halts pipeline
- Optional `onStageError` callback for logging/alerting

## Notes
- All stage functions support async
- `transform()` returns a new `Pipeline<O>` with updated type - stages are composable
- No external deps - pure TypeScript

## Exit criteria
- [ ] Tests written in `packages/tools/data-pipeline.test.ts`
- [ ] Integrated into `packages/tools/index.ts`
- [ ] Used by at least one agent workflow
