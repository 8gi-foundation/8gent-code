# @8gent/qdrant-client

Thin typed wrapper around a local-only Qdrant instance for the 8gent Computer
on-device Mac agent. Gives `@8gent/memory` and the security review a stable
surface to reason about while the real wiring is designed.

## Status

v0 is stubs only. Every method throws `NotImplementedError`. Do not use
against a real store yet.

- Parent PRD: [#1746](https://github.com/8gi-foundation/8gent-code/issues/1746)
- Architecture spike: PR [#1747](https://github.com/8gi-foundation/8gent-code/pull/1747)
- This seam issue: [#1756](https://github.com/8gi-foundation/8gent-code/issues/1756)
- Security review that must land before v1: [#1748](https://github.com/8gi-foundation/8gent-code/issues/1748)

## Scope

- v1 binds to `127.0.0.1:6333` only. No LAN or remote access.
- Encryption at rest is handled by the caller or the filesystem, not by this
  package.
- Auth token (if used) is passed in via options and sourced from Keychain by
  the caller.

## Surface

```ts
import { createClient } from "@8gent/qdrant-client";

const client = createClient({ host: "127.0.0.1", port: 6333 });

await client.healthCheck();
await client.upsert("memories", [{ id: "1", vector: [0.1, 0.2], payload: { tier: "open" } }]);
const hits = await client.search("memories", [0.1, 0.2], 5);
```

## Non-goals

- Clustering, sharding, or multi-node.
- Schema migration tooling (that lives in `@8gent/memory`).
- Bundling the Qdrant binary or Docker plumbing. See #1748 for that decision.
