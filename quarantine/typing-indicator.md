# quarantine/typing-indicator

## What

Animated typing indicator for terminal output - shows dots, spinner, or braille animation while waiting for model responses.

## Location

`packages/tools/typing-indicator.ts` (~70 lines)

## API

```ts
import { TypingIndicator } from "./packages/tools/typing-indicator";

const indicator = new TypingIndicator({ style: "braille", label: "Thinking" });
indicator.start();
// ... await model response ...
indicator.stop();
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `style` | `"dots" \| "spinner" \| "braille"` | `"braille"` | Animation style |
| `label` | `string` | `"Thinking"` | Text prefix before the animation |
| `intervalMs` | `number` | `80` | Frame interval in milliseconds |
| `stream` | `NodeJS.WriteStream` | `process.stderr` | Output stream |

### Properties

- `active: boolean` - whether the indicator is currently animating

## Design decisions

- Writes to stderr by default so it does not pollute stdout pipes.
- Hides/restores terminal cursor during animation to avoid flicker.
- Clears its own output on stop - no leftover characters.
- `start()` is idempotent (safe to call twice).
- Zero dependencies - only uses ANSI escape codes and `setInterval`.

## Graduation criteria

- Wire into the TUI agent loop (`packages/eight/agent.ts`) as the waiting state between user input and first model token.
- Verify clean teardown in all terminal emulators (iTerm2, Terminal.app, VS Code integrated terminal).
- Add unit test confirming `stop()` restores cursor and leaves no residual output.
