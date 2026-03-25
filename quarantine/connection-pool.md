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
  idleTimeout: 30_000,
  acquireTimeout: 5_000,
  create: async () => new MyDBConn(),
  destroy: async (conn) => conn.close(),
  validate: async (conn) => conn.isAlive(),
});

const conn = await pool.acquire();
try {
  await conn.query("SELECT 1");
} finally {
  await pool.release(conn);
}

await pool.destroy(conn);
console.log(pool.stats()); // { total, active, idle, waiting, min, max }
await pool.drain();
```

## Features

- `acquire()` - returns idle validated connection, grows to max, or waits FIFO
- `release(conn)` - returns to pool or hands directly to next waiter
- `destroy(conn)` - removes connection, replenishes pool to min
- `drain()` - rejects all waiters, destroys all connections
- `stats()` - live counts of total/active/idle/waiting/min/max
- Idle reaper interval = idleTimeout/2, never drops below min

## Constraints

- No retry on failed create() - caller is responsible
- validate() runs on every acquire from idle - keep it fast
- drain() is irreversible - always call before process exit

## Files

- `packages/tools/connection-pool.ts` (~130 lines)

## Not doing

- No priority acquire - FIFO only
- No metrics export
- No retry on validate failure for waiting acquires
