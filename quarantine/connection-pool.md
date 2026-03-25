# quarantine: connection-pool

**Status:** quarantine - review before wiring into agent loop

## What it does

`ConnectionPool<T>` is a generic resource pool for database connections, HTTP clients,
or any expensive-to-create resource. Handles lifecycle: min/max sizing, idle timeout
reaping, acquire timeout, and health validation before reuse.

## API

```ts
import { ConnectionPool } from "../packages/tools/connection-pool.ts";

const pool = new ConnectionPool<MyDBConn>({
  min: 2,
  max: 10,
  idleTimeout: 30_000,      // 30s - destroy idle connections
  acquireTimeout: 5_000,    // 5s - throw if no connection available
  create: async () => new MyDBConn(),
  destroy: async (conn) => conn.close(),
  validate: async (conn) => conn.isAlive(), // optional health check
});

// Acquire / release pattern
const conn = await pool.acquire();
try {
  await conn.query("SELECT 1");
} finally {
  await pool.release(conn);
}

// Destroy a bad connection explicitly (pool replenishes to min)
await pool.destroy(conn);

// Stats
console.log(pool.stats());
// { total: 3, active: 1, idle: 2, waiting: 0, min: 2, max: 10 }

// Graceful shutdown
await pool.drain(); // destroys all connections, rejects pending waiters
```

## Features

- `acquire()` - returns idle validated connection, grows to max, or waits FIFO
- `release(conn)` - returns to pool or hands directly to next waiter
- `destroy(conn)` - removes connection, replenishes pool to min
- `drain()` - graceful shutdown; rejects all waiters, destroys all connections
- `stats()` - live counts of total/active/idle/waiting/min/max
- Idle reaper runs at `idleTimeout / 2` interval, never drops below min
- Acquire timeout throws with clear message rather than hanging

## Constraints

- No retry on failed `create()` - caller is responsible
- `validate()` runs on every acquire from idle pool - keep it fast
- `drain()` is irreversible - pool cannot be reused after calling
- Idle reaper uses `setInterval` - always call `drain()` before process exit
- No priority acquire - FIFO only

## Files

- `packages/tools/connection-pool.ts` - implementation (~140 lines)

## Not doing

- No connection borrowing limits per caller
- No metrics export (wrap stats() in your own instrumentation)
- No retry on validate failure for waiting acquires
