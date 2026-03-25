# pubsub

In-process pub/sub with topics, wildcards, and backpressure.

## Requirements
- subscribe(topic, handler) -> unsubscribe function
- Wildcard topics: 'user.*' matches 'user.created'
- publish(topic, data) -> Promise<void>
- Backpressure: drop or queue when handler is slow
- subscribeOnce(topic) -> Promise<data>

## Status

Quarantine - pending review.

## Location

`packages/tools/pubsub.ts`
