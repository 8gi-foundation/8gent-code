# Quarantine: service-registry

**Status:** Under review
**File:** `packages/tools/service-registry.ts`
**Export:** `ServiceRegistry`

## Purpose

In-memory service registry for discovering and tracking agent services by name and version. Designed for multi-agent coordination within the 8gent ecosystem where sub-agents and kernel processes need to find each other at runtime.

## API

```ts
import { ServiceRegistry } from './packages/tools/service-registry.ts';

const registry = new ServiceRegistry();

// Register a service
registry.register('memory-store', 'http://localhost:3001', { version: '1.0.0', tags: ['storage'] });

// Discover - returns first healthy instance, optionally filtered by version
const svc = registry.discover('memory-store');
const svcV1 = registry.discover('memory-store', '1.0.0');

// Heartbeat - call periodically to keep the entry alive (30s TTL)
registry.heartbeat('memory-store');

// Deregister - remove one instance or all instances of a name
registry.deregister('memory-store', 'http://localhost:3001');
registry.deregister('memory-store'); // all instances

// List all healthy entries
const all = registry.listAll();

// Health summary
const { total, healthy, stale } = registry.health();
```

## Behaviour

- Heartbeat TTL: 30 seconds. Entries not refreshed within 30s are pruned on the next `discover` or `listAll` call.
- Multiple instances of the same service name can be registered with different URLs (e.g. replicas).
- `discover` returns the first healthy match. No load-balancing - intentionally simple.
- `deregister` without a URL removes all instances of that name.

## Graduation Criteria

- [ ] Integrated into `packages/eight/agent.ts` or `packages/daemon/` for sub-agent coordination
- [ ] Heartbeat called by each sub-agent on a timer
- [ ] Tested under concurrent registration (worktree pool scenario)
- [ ] Optionally: persistence via SQLite for cross-restart survival
