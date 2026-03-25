# Quarantine: cli-spinner

## What

`packages/tools/spinner.ts` - a zero-dependency terminal spinner with 4 styles, success/fail end-states, and timed auto-stop.

## Why quarantined

New utility, not yet wired into any existing tool or TUI component. Needs review before integration.

## API

```ts
import { Spinner } from '../packages/tools/spinner';

const s = new Spinner({ style: 'braille', text: 'Fetching...' });
s.start();
s.update('Almost there...');
s.succeed('Fetched 42 items');
// or: s.fail('Network error');
```

### Styles

| Style | Frames |
|-------|--------|
| `dots` | `.  ` `.. ` `...` ` ..` `  .` `   ` |
| `bars` | `\|` `/` `-` `\` |
| `braille` | Unicode braille rotation |
| `arrows` | Unicode arrow rotation |

### Options

| Option | Type | Default |
|--------|------|---------|
| `style` | `'dots' \| 'bars' \| 'braille' \| 'arrows'` | `'braille'` |
| `text` | `string` | `''` |
| `timeout` | `number` (ms) | `0` (disabled) |
| `stream` | `NodeJS.WriteStream` | `process.stderr` |

### Methods

- `start(text?)` - begin spinning
- `stop()` - clear and stop
- `autoStop(ms)` - returns a Promise that resolves after stopping
- `succeed(text?)` - stop with green checkmark
- `fail(text?)` - stop with red cross
- `update(text)` - change text mid-spin
- `isSpinning` - boolean getter

## Integration path

1. Review API surface
2. Wire into `packages/tools/index.ts` export
3. Replace any ad-hoc spinner usage in TUI or CLI scripts
4. Add tests

## Files

- `packages/tools/spinner.ts` (~95 lines)
