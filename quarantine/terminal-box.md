# Quarantine: terminal-box

## What

Self-contained Unicode box drawing utility for terminal output. Wraps any text content in a styled border with five border styles, configurable padding and margin, an optional titled top edge with left/center/right alignment, and ANSI color output for the border. Multi-line input is handled natively. Zero dependencies beyond Bun/Node built-ins.

## File

`packages/tools/terminal-box.ts` (~145 lines)

## Status

**quarantine** - new file, untested in CI, not yet wired into tool registry.

## API

```ts
import { box } from './packages/tools/terminal-box.ts';

// Minimal
console.log(box('Hello, world!'));

// Titled, colored, double border
console.log(box('Deploy complete.', {
  style: 'double',
  title: 'Status',
  titleAlignment: 'center',
  borderColor: 'cyan',
  padding: { x: 2, y: 1 },
  margin: { x: 2, y: 0 },
}));

// Fixed width, rounded corners
console.log(box('short', { style: 'round', width: 40 }));

// ASCII fallback
console.log(box('Fallback output', { style: 'ascii' }));
```

## Border styles

| Style | Description |
|-------|-------------|
| `single` | Standard single-line Unicode box |
| `double` | Double-line Unicode border |
| `round` | Rounded corners, thin edges |
| `bold` | Heavy/bold line weight |
| `ascii` | Safe ASCII fallback (`+`, `-`, `|`) |

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `style` | `BoxStyle` | `'single'` | Border character set |
| `padding` | `number \| {x?,y?}` | `1` (x), `0` (y) | Inner spacing from border to content |
| `margin` | `number \| {x?,y?}` | `0` | Outer spacing around the box |
| `title` | `string` | - | Text embedded in the top border edge |
| `titleAlignment` | `'left' \| 'center' \| 'right'` | `'left'` | Position of title along top edge |
| `borderColor` | `string` | - | ANSI named color for border characters |
| `width` | `number` | auto | Fix total box width |

## Supported border colors

`black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`

## Integration path

- [ ] Add export to `packages/tools/index.ts`
- [ ] Register as an agent-callable tool in `packages/eight/tools.ts`
- [ ] Add unit tests: all five styles, title alignment variants, multi-line input, ANSI stripping in width calculation, fixed-width clipping
- [ ] Wire into TUI debug and info panels as a styled output primitive
- [ ] Consider `width: 'terminal'` auto-detect via `process.stdout.columns`
