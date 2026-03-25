# signal-handler

**Status:** quarantine

## Description

Graceful process signal handling with ordered cleanup callbacks and configurable timeout. Prevents double-exit on repeated signals.

Handles: `SIGINT` (Ctrl+C), `SIGTERM` (process kill), `SIGHUP` (terminal hangup).

## API

- `onShutdown(fn)` - register a cleanup callback on the module-level singleton
- `configureSignalHandler(options)` - configure timeout and exit code before registrations
- `SignalHandler` class - instantiable for explicit control

## Integration Path

- Wire into `packages/eight/agent.ts` to flush memory/checkpoint on agent exit
- Wire into `packages/daemon/` vessel daemon shutdown sequence
- Replace ad-hoc `process.on('SIGINT')` calls scattered across TUI entrypoints

## Notes

- Callbacks run in registration order (FIFO)
- Default cleanup timeout: 5000ms before force-exit
- Safe to call `onShutdown` multiple times - callbacks accumulate
- Double-exit protected: second signal is ignored once shutdown begins
