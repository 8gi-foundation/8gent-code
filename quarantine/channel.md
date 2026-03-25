# Tool: Channel

## Description

Go-style channels for async communication between tasks. Supports buffered channels with configurable capacity, blocking send/receive semantics, channel close signalling, and `select` for racing across multiple channels.

## Status

**quarantine** - implemented, not yet wired into the agent tool registry or any package exports.

## Integration Path

1. Export from `packages/tools/index.ts` once reviewed.
2. Register as an agent tool in `packages/eight/tools.ts` if inter-task messaging is needed at the agent loop level.
3. Use in `packages/orchestration/` as the messaging primitive between worktree workers instead of ad hoc filesystem polling.
4. Candidate for replacing the lease-based job queue in `packages/memory/` with a typed channel abstraction.

## API

```ts
import { Channel, select } from "../packages/tools/channel.ts";

// Unbuffered (blocks sender until receiver is ready)
const ch = new Channel<string>();

// Buffered (up to 4 values queued without blocking)
const buffered = new Channel<number>(4);

await ch.send("hello");
const value = await ch.receive(); // "hello"

ch.close(); // unblocks all waiting receivers with undefined

// Select: receive from whichever channel fires first
const { channel, value } = await select(ch1, ch2, ch3);

// Async iteration until close
for await (const item of ch) {
  console.log(item);
}
```
