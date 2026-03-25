# event-bus

Typed publish-subscribe event bus.

## Requirements
- on(event, handler) and off(event, handler)
- once(event, handler) auto-unsubscribes after first call
- emit(event, data) synchronous dispatch
- emitAsync(event, data) -> Promise<void> sequential async
- TypeScript generic EventMap for type-safe events

## Status

Quarantine - pending review.

## Location

`packages/tools/event-bus.ts`
