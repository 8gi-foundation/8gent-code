# stream-buffer

**Status:** Quarantine - pending review
**File:** `packages/tools/stream-buffer.ts`
**Class:** `StreamBuffer`

## What it does

Buffers stream data (strings, Uint8Array, Buffer) and flushes in configurable batches. Useful for reducing write frequency when consuming high-throughput streams.

## Flush strategies

| Strategy | Option | Behaviour |
|----------|--------|-----------|
| Size | `sizeThreshold` (bytes) | Flush when buffered bytes >= threshold |
| Count | `countThreshold` (chunks) | Flush when chunk count >= threshold |
| Time | `intervalMs` (ms) | Auto-flush on a repeating timer |

Strategies are combinable - first threshold reached wins.

## API

```ts
import { StreamBuffer } from "./packages/tools/stream-buffer.ts";

const buf = new StreamBuffer({
  sizeThreshold: 4096,        // flush at 4 KB
  countThreshold: 100,        // or 100 chunks
  intervalMs: 500,            // or every 500 ms
  onFlush: async (chunks) => {
    // process Uint8Array[]
  },
  onDrain: () => console.log("drained"),
});

buf.write("hello world");
buf.write(new Uint8Array([0x01, 0x02]));

buf.pause();          // stop auto-flush
buf.resume();         // restart auto-flush
await buf.flush();    // manual flush
await buf.drain();    // flush remainder + call onDrain
buf.destroy();        // stop timer, clear buffer

buf.bufferedBytes;    // bytes currently held
buf.bufferedChunks;   // chunk count currently held
```

## Notes

- All options are optional. Without any thresholds the buffer only flushes on manual `flush()` / `drain()` calls.
- `drain()` triggers `onDrain` after the final flush, suitable for graceful shutdown.
- `destroy()` clears the interval timer - call it when the buffer is no longer needed to avoid leaks.
