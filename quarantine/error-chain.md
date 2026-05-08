# error-chain

**Status:** quarantine

## Description

Chainable error context wrapping for debugging multi-layer failures. Provides `ChainedError` - an `Error` subclass that carries a cause chain and a key-value context map at each layer - plus a `wrap()` helper that converts any thrown value into a `ChainedError`.

Key features:
- `cause` chain - each `ChainedError` holds the error that triggered it, traversable to the root.
- `context` map - arbitrary key-value metadata (layer name, SQL query, user ID, etc.) attached at the throw site.
- `fullStack` - concatenated stack trace across all cause layers, separated by "Caused by:" headers.
- `toJSON()` - recursive serialization of the full chain; safe to `JSON.stringify`.
- `wrap(error, context)` - one-liner to add context at any catch boundary without losing the original cause.
- `isChainedError(value)` - type-guard for narrowing in catch blocks.

## Integration Path

1. Import from `packages/tools/error-chain.ts` - no external dependencies.
2. Replace bare `throw err` at catch boundaries with `throw wrap(err, { layer: 'X', ...metadata })`.
3. In top-level error handlers, call `.toJSON()` to log the full chain as structured JSON, or read `.fullStack` for human-readable output.
4. Wire into `packages/eight/agent.ts` tool-execution catch blocks and `packages/validation/` checkpoint-revert logic once validated.
