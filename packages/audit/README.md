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
