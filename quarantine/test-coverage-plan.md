# Test Coverage Plan

Current score: 0/35. Target: 25/35 within 2 weeks.

## Phase 1 - Stubs (this PR)

Bun:test stubs for the 3 most critical packages:

| Package | Test file | Scenarios |
|---------|-----------|-----------|
| `packages/memory/` | `store.test.ts` | write, get, recall, forget, batch |
| `packages/permissions/` | `policy-engine.test.ts` | load, evaluate, addPolicy, block, allow, require_approval |
| `packages/orchestration/` | `agent-mesh.test.ts` | join, leave, listPeers, send, consume, broadcast |

## Phase 2 - Fill stubs with assertions

Priority order (by blast radius if broken):

1. **Memory store** - everything depends on recall working. Add edge cases: empty DB, duplicate IDs, FTS ranking, decay.
2. **Policy engine** - security-critical. Add: wildcard rules, OR/AND conditions, disabled rules, environment filtering.
3. **Agent mesh** - multi-agent coordination. Add: stale heartbeat cleanup, concurrent joins, message ordering.

## Phase 3 - Expand to remaining packages

| Package | Priority | Why |
|---------|----------|-----|
| `packages/eight/agent.ts` | HIGH | Core agent loop - abort, checkpoint, restore |
| `packages/eight/tools.ts` | HIGH | Tool definitions - wrong tool = wrong action |
| `packages/validation/` | MEDIUM | Checkpoint-verify-revert healing loop |
| `packages/self-autonomy/` | MEDIUM | Reflection, skill confidence, meta-mutation |
| `packages/tools/browser/` | MEDIUM | Fetch, scrape, cache |
| `packages/music/` | LOW | DJ streaming - hard to unit test (mpv dependency) |
| `packages/proactive/` | LOW | Bounty scanner - external API dependent |

## Phase 4 - CI integration

- Add `bun test` to GitHub Actions on PR
- Fail PR if any test fails
- Add coverage threshold (start at 20%, ratchet up)

## Running tests

```bash
bun test                                    # all tests
bun test packages/memory/store.test.ts      # single package
bun test --coverage                         # with coverage report
```
