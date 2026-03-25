# Quarantine: hash-router

**Status:** Quarantined - not wired into agent yet
**Package:** `packages/tools/hash-router.ts`
**Lines:** ~140

## What it does

Consistent hash ring for distributing load across named nodes. Uses virtual nodes (vnodes) to minimise rebalancing when cluster membership changes. Supports weighted routing so heavier nodes absorb proportionally more traffic.

## API

```ts
import { HashRing } from "./packages/tools/hash-router.ts";

const ring = new HashRing();

// Add nodes - weight defaults to 1
ring.addNode("node-a");
ring.addNode("node-b", 2); // 2x capacity - gets 2x vnodes
ring.addNode("node-c", 0.5); // half capacity

// Route a key to the responsible node
const node = ring.route("user:1234"); // "node-b"

// Replica routing - get n distinct nodes for a key
const replicas = ring.getN("user:1234", 2); // ["node-b", "node-a"]

// Remove a node - ring rebalances automatically
const stats = ring.removeNode("node-b");
console.log(stats.removedVnodes); // how many vnodes were released

// Inspect current ring state
console.log(ring.stats()); // [{ id, weight, vnodes }, ...]
console.log(ring.nodeCount()); // 2
```

## Design choices

- **FNV-1a 32-bit hash** - fast, good distribution, no dependencies
- **Virtual nodes = 150 * weight** - tunable constant balances memory vs uniformity
- **Binary search on sorted ring** - O(log n) per lookup
- **Deduplication in getN** - returns distinct physical nodes, not vnodes

## Use cases inside 8gent

- Route agent sessions to daemon workers by session ID
- Distribute memory store shards across nodes
- Load balance tool calls across provider endpoints
- Assign worktree slots to tasks consistently

## Rebalance stats

Both `addNode` and `removeNode` return a `RebalanceStats` object:

```ts
interface RebalanceStats {
  before: NodeStats[];   // ring state before change
  after: NodeStats[];    // ring state after change
  addedVnodes: number;
  removedVnodes: number;
}
```

## What it does NOT do

- No network I/O - pure in-memory ring
- No persistence - ring state is ephemeral
- No health checks or auto-removal of failed nodes
- No async interface - all methods are synchronous

## To promote out of quarantine

1. Wire into `packages/orchestration/` for worktree slot assignment
2. Add to `packages/daemon/` for session-to-worker routing
3. Write benchmark: key distribution uniformity test
4. Add to agent tool registry in `packages/eight/tools.ts`
