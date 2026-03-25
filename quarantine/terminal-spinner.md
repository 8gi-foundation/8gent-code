# terminal-spinner

**Tool name:** terminal-spinner
**Package path:** `packages/tools/terminal-spinner.ts`
**Status:** quarantine

## Description

Animated terminal spinners with status text for CLI feedback. Supports four built-in styles (dots, line, arc, bouncingBall), live text updates without restarting, and terminal-clean success/fail/warn/info stop states using ANSI escape codes. Writes to stderr by default so spinner output does not pollute stdout pipelines.

Exports `Spinner` class and `createSpinner(options?)` convenience factory.

## Integration path

1. Import `createSpinner` from `packages/tools/terminal-spinner.ts`.
2. Call `.start(text)` before a long-running async operation.
3. Call `.succeed(text)`, `.fail(text)`, `.warn(text)`, or `.info(text)` on completion.
4. Use `.update(text)` mid-operation to report progress without restarting.
5. Wire into Eight agent tool calls (e.g. shell commands, LLM inference) for user-facing feedback in the TUI CLI path.

## Example

```ts
import { createSpinner } from "../packages/tools/terminal-spinner.ts";

const s = createSpinner({ style: "dots" });
s.start("Running shell command...");

await runSomeAsyncTask();

s.succeed("Command complete.");

// Or on failure:
s.fail("Command failed - see logs above.");
```
