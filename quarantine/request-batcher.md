# request-batcher

## Tool Name
`request-batcher`

## Description
Batches multiple individual API requests into single bulk calls using configurable size and time windows. Each caller gets their own resolved/rejected promise mapped back from the batch response. Failed batches are retried with exponential backoff.

## Status
`quarantine` - self-contained, not wired into any agent or pipeline yet.

## Location
`packages/tools/request-batcher.ts`

## Exports
- `RequestBatcher<TInput, TOutput>` - generic class
- `BatcherOptions<TInput, TOutput>` - config interface

## Key Options
| Option | Default | Description |
|--------|---------|-------------|
| `maxBatchSize` | 25 | Flush when queue reaches this size |
| `windowMs` | 50 | Max ms to wait before flushing partial batch |
| `executor` | required | `(inputs: TInput[]) => Promise<TOutput[]>` |
| `maxRetries` | 2 | Retry attempts on batch failure |
| `retryDelayMs` | 100 | Base delay for exponential backoff |

## Integration Path
1. Wire into `packages/tools/browser/` HTTP client to batch parallel fetch calls.
2. Wire into `packages/memory/store.ts` embedding requests (Ollama batch API).
3. Expose as a tool primitive in `packages/eight/tools.ts` for agent use.
4. Add to the Nine Powers table under a future "Network" or "Performance" package.

## Example
```ts
import { RequestBatcher } from './packages/tools/request-batcher';

const batcher = new RequestBatcher<string, string>({
  maxBatchSize: 20,
  windowMs: 50,
  executor: async (inputs) => myBulkEmbedApi(inputs),
});

const result = await batcher.request('hello world');
```
