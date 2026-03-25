# typed-event-emitter

Node.js EventEmitter replacement with TypeScript event map types.

## Requirements
- TypedEventEmitter<Events extends Record<string, unknown>>
- on(event, handler), off(event, handler), emit(event, data)
- once(event) -> Promise<data>
- listenerCount(event) and removeAllListeners(event?)
- Fully type-safe - no string-keyed event leakage

## Status

Quarantine - pending review.

## Location

`packages/tools/typed-event-emitter.ts`
