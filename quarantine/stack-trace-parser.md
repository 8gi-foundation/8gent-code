# stack-trace-parser

## Description

Parses V8/Node.js error stack traces into structured `StackFrame` objects. Each frame captures function name, file path, line number, and column number. Frames from `node_modules` and Node.js internals are flagged and excluded from `relevantFrames`, leaving only application-level frames for inspection.

## Status

**quarantine** - self-contained, zero external dependencies, not yet wired into agent tooling.

## Exports

| Export | Description |
|--------|-------------|
| `parseStackTrace(stack)` | Main function. Returns `ParsedStack` with `message`, `frames`, `relevantFrames`, and `primaryFrame`. |
| `formatFrame(frame)` | Formats a single `StackFrame` as `function (file:line:col)` string. |
| `StackFrame` | Interface for a single parsed frame. |
| `ParsedStack` | Interface for the full parse result. |

## Integration Path

1. Wire into `packages/eight/tools.ts` as an agent-callable tool so Eight can parse error output from shell commands and surface the primary frame in its reasoning context.
2. Use in `packages/validation/` checkpoint-verify loop to extract frame context when a tool call throws, feeding file and line into the rollback decision.
3. Feed `primaryFrame.file` into memory as episodic context so Eight accumulates a history of recurring failure locations.

## Source

`packages/tools/stack-trace-parser.ts`
