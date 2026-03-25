# Quarantine: file-based pub/sub message broker

**Status:** Quarantine - awaiting review before wiring into any consumer.

## What it is

`packages/orchestration/message-broker.ts` - a zero-dependency file-based pub/sub
broker for coordinating work across agents, worktrees, and daemons inside the
8gent-code monorepo.

## Why file-based

- No Redis, no RabbitMQ, no Kafka. Zero infra to spin up.
- Works in local Ollama mode and in the Fly.io daemon (any writable volume).
- Survives process restarts - messages are durable on disk until acked or expired.

## Core concepts

| Concept | How it works |
|---------|-------------|
| **Topic** | Named channel. A directory under `.8gent/broker/topics/<topic>/`. |
| **Consumer group** | Named subscriber. Messages are fanned out per group - each group gets its own copy. |
| **Message persistence** | Published messages written to `.8gent/broker/archive/<topic>/` (replay log). |
| **Inflight / visibility timeout** | Consumed messages moved to `inflight/` dir. If not acked within `visibilityTimeoutMs` (default 30s) they are re-queued. |
| **Acknowledgment** | `ack()` removes from inflight. `nack()` re-queues or DLQs if attempts exhausted. |
| **Dead letter queue** | After `maxAttempts` (default 3) failures, message lands in `dlq/<topic>/<group>/`. |
| **Replay** | `replay(topic, group, { fromTimestamp })` re-enqueues archived messages for a group. `replayDlq()` rescues DLQ messages. |

## Usage

```ts
import { MessageBroker } from "./packages/orchestration/message-broker.ts";

const broker = new MessageBroker({ dataDir: ".8gent/broker" });

// Producer
broker.subscribe("tasks", "worker-pool");          // register group first
broker.publish("tasks", { type: "lint", path: "src/foo.ts" });

// Consumer
const messages = broker.consume("tasks", "worker-pool", "worker-1");
for (const msg of messages) {
  try {
    await processTask(msg.payload);
    broker.ack("tasks", "worker-pool", msg.id);
  } catch {
    broker.nack("tasks", "worker-pool", msg.id);   // re-queue or DLQ
  }
}

// Introspection
console.log(broker.stats("tasks", "worker-pool"));
// { topic: 'tasks', group: 'worker-pool', queued: 0, inflight: 0, dlq: 0 }
```

## Directory layout

```
.8gent/broker/
  topics/<topic>/groups.json          # registered consumer groups
  archive/<topic>/<id>.json           # immutable replay log
  queues/<topic>/<group>/<id>.json    # pending messages
  inflight/<topic>/<group>/<id>.json  # consumed, awaiting ack
  dlq/<topic>/<group>/<id>.json       # dead letters
```

## API surface

| Method | Description |
|--------|-------------|
| `publish(topic, payload, opts?)` | Publish a message |
| `subscribe(topic, group)` | Register consumer group |
| `unsubscribe(topic, group)` | Remove consumer group |
| `consume(topic, group, consumerId, opts?)` | Poll messages (moves to inflight) |
| `ack(topic, group, messageId)` | Confirm processing |
| `nack(topic, group, messageId)` | Reject - re-queue or DLQ |
| `replay(topic, group, opts?)` | Replay archived messages |
| `replayDlq(topic, group)` | Rescue DLQ messages |
| `listDlq(topic, group)` | Inspect DLQ |
| `depth(topic, group)` | Queue depth |
| `inflight(topic, group)` | Inflight count |
| `dlqDepth(topic, group)` | DLQ depth |
| `stats(topic, group)` | Full stats snapshot |
| `purge(topic, group)` | Discard pending messages |
| `listTopics()` | All registered topics |

## Constraints

- **Concurrency:** File operations are not atomic across all OS/FS combinations.
  Safe for single-process multi-worktree use. True multi-process fanout would
  need a file lock layer (out of scope).
- **Performance:** Not suited for high-throughput use. This is an agent
  coordination bus, not a stream processor.
- **No TTL on archive:** The replay log grows unbounded. Add a pruning job if
  archive size becomes a concern.

## Files touched

- `packages/orchestration/message-broker.ts` (new)
- `quarantine/message-broker.md` (this file)

No existing files modified.
