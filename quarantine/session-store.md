# Quarantine: session-store

**Package:** `packages/tools/session-store.ts`
**Status:** Quarantine - not yet wired into the agent loop
**Branch:** `quarantine/session-store`

---

## What it does

`SessionStore` is a typed, in-memory key-value store with per-entry TTL, periodic
cleanup, JSON disk persistence, and namespace support. Designed to hold transient
agent state that should survive a restart but expire after a configurable window.

---

## Design

### Namespaces

Every key is prefixed with a namespace (`default` unless overridden). Multiple
agents or tools can share one store instance without key collisions.

```ts
store.set("token", "abc", { namespace: "oauth", ttlMs: 3_600_000 });
store.get("token", "oauth"); // "abc"
```

### TTL per entry

Each `set()` call accepts an optional `ttlMs`. On `get()`, expired entries are
evicted lazily and `undefined` is returned. A background interval (default 60 s)
runs `cleanup()` to proactively evict all expired entries.

### Disk persistence

`store.save()` writes non-expired entries to the configured JSON file.
`store.load()` restores state, skipping any expired entries.

### Cleanup interval

Timer is created with `unref()` so it does not prevent process exit.
Call `store.destroy()` to clear the interval explicitly.

---

## Integration plan (when graduating from quarantine)

1. Import `SessionStore` in `packages/eight/agent.ts`.
2. Instantiate once per daemon session with a shared persist path:
   ```ts
   const session = new SessionStore({
     persistPath: ".8gent/session.json",
     cleanupIntervalMs: 30_000,
     defaultNamespace: "agent",
   });
   ```
3. Store short-lived auth tokens, tool results, and conversation metadata.
4. Namespace per user or worktree for multi-agent workloads.
5. Call `session.save()` at checkpoint and `session.destroy()` on graceful shutdown.
6. Expose `session.keys()` and `session.size` in the debugger panel.

---

## What is NOT done here

- Distributed / multi-process sharing (single JSON file only).
- Encryption of persisted values.
- Metrics export to benchmark harness.
- Reactive subscriptions (no pub/sub on key changes).

---

## Risks

- Concurrent writes from multiple agent threads may race on the JSON file. Use
  one store instance per process, or add a write-lock before promoting.
- Large values will inflate the JSON file. Offload big blobs to `packages/memory/`.
- TTL clock depends on `Date.now()`. Not a concern for local workloads.
