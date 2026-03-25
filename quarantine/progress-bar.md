# Quarantine: progress-bar

## File

`packages/tools/progress-bar.ts`

## What it does

Terminal progress bar utility (~100 lines). Renders a text-based progress bar to stderr with:

- Percentage complete
- ETA countdown
- Speed (items/second)
- Elapsed time
- Custom format strings with tokens (`:bar`, `:percent`, `:eta`, `:speed`, `:elapsed`, `:current`, `:total`, `:id`)
- Multiple concurrent bars (ANSI cursor movement on TTY, line-per-update on non-TTY)

## API

```ts
import { ProgressBar } from './packages/tools/progress-bar.ts';

const pb = new ProgressBar(); // defaults to stderr

pb.create('download', { total: 500, width: 40 });
pb.update('download', 250);   // jump to 250/500
pb.increment('download', 10); // advance by 10
pb.remove('download');         // clean up

pb.active; // count of bars not yet complete
```

### ProgressBarOptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `total` | `number` | required | Total items |
| `width` | `number` | `30` | Bar character width |
| `format` | `string` | `[:bar] :percent \| :speed/s \| ETA :eta \| :current/:total` | Format template |
| `fillChar` | `string` | `#` | Filled portion character |
| `emptyChar` | `string` | `-` | Empty portion character |
| `stream` | writable | `process.stderr` | Output stream |

## Why quarantined

New utility - needs integration testing with real TUI, validation that ANSI cursor movement works across terminal emulators, and confirmation it doesn't conflict with Ink's rendering.

## Exit criteria

- [ ] Unit tests covering single and concurrent bar rendering
- [ ] Manual test in at least 3 terminals (iTerm2, Terminal.app, VS Code)
- [ ] Confirm no interference with Ink TUI rendering
- [ ] Wire into at least one real use case (file download, benchmark progress)
