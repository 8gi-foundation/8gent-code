# @8gent/audit

Append-only access audit log for child records. Implements the detective
control required by the 8gentjr interim DPIA (G7 split): every read of a
child-associated record is logged with who, what, when, why. Metadata only;
record content is never written here.

## Schema

Single SQLite table `access_audit_log`:

| Column       | Type    | Notes                                         |
|--------------|---------|-----------------------------------------------|
| id           | TEXT PK | `aud_<base36>_<rand>`                         |
| created_at   | INTEGER | ms since epoch                                |
| actor        | TEXT    | opaque caller id                              |
| actor_kind   | TEXT    | `human` \| `agent` \| `system`                |
| target_table | TEXT    | logical table name, e.g. `child_profile`      |
| target_id    | TEXT    | primary key of the record being accessed      |
| operation    | TEXT    | `read` \| `derive` \| `export`                |
| reason       | TEXT    | operation code or note                        |
| session_id   | TEXT    | optional session/request id for correlation   |

`AccessAuditStore` exposes no update, delete, truncate, or clear method. The
test suite enforces this. Indexes cover `(target_table, target_id)`, `actor`,
`created_at DESC`, and `session_id`.

## API

```ts
import { logAccess, queryAccess } from "@8gent/audit";

logAccess({
  actor: "agent:speech-coach",
  actorKind: "agent",
  targetTable: "child_profile",
  targetId: child.id,
  operation: "read",
  reason: "render home screen",
  sessionId: session.id,
});

const events = queryAccess({ targetId: child.id, limit: 100 });
```

Shared store opens at `$EIGHT_DATA_DIR/audit/access.db` (or
`~/.8gent/audit/access.db`). Use `getAccessAuditStore(path)` or `new
AccessAuditStore(path)` for dedicated paths.

## Admin CLI

```bash
bun run packages/audit/cli.ts tail --limit 50
bun run packages/audit/cli.ts query --target child_123
bun run packages/audit/cli.ts query --actor human:parent_1 --since 1713715200000
bun run packages/audit/cli.ts stats
```

Read-only.

## Tool-call decision chain (NemoClaw v2, #2756 step 3)

`DecisionAuditStore` (`decision-store.ts`) is a second, tamper-evident log:
every tool-call policy decision made by
`packages/permissions/policy-engine.ts::evaluateToolCall` - allow or deny,
from the capability-manifest gate or the rule pipeline - is appended to a
SHA-256 hash chain (`entry_hash = SHA-256(prev_hash + canonical payload)`).

Properties:

- **Append only.** No update/delete methods; the head read + insert run in
  one transaction so linkage cannot race.
- **Tamper-EVIDENT.** `verifyChain()` recomputes every hash: an edited
  entry, an interior deletion, or a reorder is reported with the first
  broken seq. Tail truncation is only detectable against an externally
  anchored head - `head()` exists for exactly that anchoring.
- **Never a credential store.** The permissions package scrubs secrets from
  the request detail (`goal-secret-scrub`) BEFORE logging. This package
  stays dependency-free of permissions to avoid a cycle.
- **Fail-open by default, fail-closed on demand.** An unwritable trail is
  warn-and-continue; with `AUDIT_STRICT=1` the policy engine denies any
  tool call it cannot audit.

```ts
import { queryToolDecisions, verifyDecisionChain } from "@8gent/audit";

const denies = queryToolDecisions({ decision: "deny", limit: 50 });
const chain = verifyDecisionChain(); // { valid, entries, headHash | brokenAtSeq }
```

Shared store opens at `$EIGHT_DATA_DIR/audit/decisions.db` (or
`~/.8gent/audit/decisions.db`).

```bash
bun run packages/audit/cli.ts decisions --tool run_command --decision deny
bun run packages/audit/cli.ts decisions --session s_123 --limit 100
bun run packages/audit/cli.ts verify   # all chains; exit 2 when one is broken
```

## Hash chain on every audit store (8gi-governance#1108)

`hash-chain.ts` makes the access and capability logs tamper-evident, the
same way the decision log already is. Each row now carries two more columns:

```
prev_hash    = hash of the chained row before it, or GENESIS_HASH
hash         = sha256_hex(prev_hash + canonical_json(row without prev_hash and hash))
GENESIS_HASH = 64 zeros
```

Canonical JSON means object keys sorted at every depth and no whitespace.
Rows are verified in insertion order (`rowid`). The first broken row is
reported by its 0-based index: an edited row fails its own hash; a deleted,
inserted or reordered row fails the `prev_hash` link. Cutting rows off the
end is only visible against a head hash kept elsewhere, so `verify` prints
the head.

**Migration.** Opening a store runs `ALTER TABLE ... ADD COLUMN` for
`prev_hash` and `hash` when they are missing. Nothing else changes. Rows
written before that have no hashes and are reported as pre-chain, never as
tampered, as long as they sit before the first chained row. A row with no
hashes after the chain has started is reported as broken.

```bash
bun run audit verify                        # access, capability, decisions
bun run audit verify --ledger merges.jsonl  # one JSONL ledger
# exit 0 when everything is ok, 2 when a chain is broken
```

## JSONL ledgers: `ledger-chain.mjs`

A dependency-free script (node:crypto and node:fs only, runs under node or
bun) for plain append files such as the factory merge ledger. Same rules as
above: one JSON object per line, and the writer adds the two fields.

```
{"repo":"8gent-code","pr":5001,"verdict":"merged","prev_hash":"000...0","hash":"9f2c..."}
```

```bash
node ledger-chain.mjs append ledger.jsonl '{"pr":5001,"verdict":"merged"}'   # or JSON on stdin
node ledger-chain.mjs verify ledger.jsonl   # "ok: N lines (P pre-chain), head H" or "broken at line L"
```

- The appended record must be a JSON object without `prev_hash` or `hash`.
- Appends take `<file>.lock` (created exclusively, stale after 30 s), so
  concurrent writers cannot fork the chain.
- Lines without hashes at the top of an existing file are pre-chain; the
  first appended line links to `GENESIS_HASH`.
- `appendChained`, `verifyLedger`, `sealLine`, `canonicalJson` and
  `chainHash` are exported for callers that import instead of shelling out.
  `hash-chain.test.ts` checks it hashes exactly like `hash-chain.ts`.

## 8gentjr integration

Two paths:

1. **Direct package import** when 8gentjr runs in-process or on the same
   host as the daemon. Add `@8gent/audit` as a workspace dependency; call
   `logAccess()` at every profile / vocabulary / transcript read site.
2. **Daemon HTTP endpoint** when 8gentjr runs separately. The daemon
   gateway exposes `POST /audit/access` with body
   `{ actor, actorKind, targetTable, targetId, operation, reason, sessionId? }`.
   If `authToken` is configured on the gateway, clients must pass it as
   `Authorization: Bearer <token>`. Returns `{ id }` on 201, or
   `{ error }` on 400/401. Implemented in
   `packages/daemon/gateway.ts::handleAuditAccess`.

Do log: reads, derivations, exports of child-associated records.
Do not log: record content, routine cache hits, non-child data reads.

DPIA reference: `8gi-governance/docs/legal/2026-04-21-8gentjr-dpia-interim.md`
section 5, G7. Closes `8gi-foundation/8gent-code#1656`.
