# 8gent Table — Phase 1 Interface Contract

**Status:** Architecture-locked. Builders implement against this; no drift without a contract revision.
**Repo split:** backend/daemon in `/Users/jamesspalding/8gent-code`; desktop UI in `/Users/jamesspalding/8gent-flow`.
**Clean-room:** rebuilt from behavior spec + our own spine. No third-party source consulted.

---

## 0. What Table is (one paragraph)

A sovereign human+agent workspace: named **channels** (chat-style `stream` or threaded `forum`) whose **members** are humans and agents. Humans post; agents post *only* through a gated `post_to_channel` write path after being `@mentioned` (that write is applied by the daemon harness, not called by the model - the model's turn runs a read-only `__table__`-scoped toolset and emits reply text only). Every mutation is appended to the existing signed, hash-chained `goal/ledger`. Messages live in a new local `bun:sqlite` DB with an FTS5 index. The daemon serves on port 18789; its **global** bind is `DAEMON_HOSTNAME` (default `0.0.0.0`), but Table `channel:*`/`message:*` frames are enforced **loopback-only per-frame** (rejected from any non-loopback peer) so Table is never reachable off-box regardless of the global bind. Agents run under a deny-by-default restricted scope with a single explicit allow.

**Non-negotiables carried from the spine:** no `bypassPermissions`; inbound channel text is UNTRUSTED and never reaches a shell tool; local model only (`eight:latest`/ollama, forced for `__table__` sessions regardless of pool runtime) unless a logged consent flag (`EIGHT_TABLE_CONSENT_CLOUD=1`) is set; **Table frames are loopback-only** enforced by a per-frame guard (not merely a global-bind assumption); every human/agent post hits the signed ledger.

---

## 1. `packages/table` store API (TypeScript)

New package `@8gent/table`. Backed by a **new** DB at `~/.8gent/table/table.db` (never the memory DB). Mirrors `packages/memory/store.ts` SQLite+FTS5 patterns. Zero cloud.

### 1.1 Domain types (`packages/table/types.ts`)

```ts
export type ChannelType = "stream" | "forum";
export type Visibility = "open" | "private";
export type MemberRole = "owner" | "admin" | "member" | "bot";

/** Participant id namespace:
 *  human agents  -> "human:<handle>"      (custodied key on disk)
 *  agent members -> "agent:<agentId>"     (daemon-minted key)
 *  Bots are agents with role "bot".  authorId/participantId always carry the prefix. */
export type ParticipantId = string;

export interface Channel {
  id: string;               // "chan_" + 24 hex (crypto.randomUUID-derived, see §4)
  name: string;             // unique, slug-safe display name
  type: ChannelType;
  visibility: Visibility;
  topic?: string;
  createdBy: ParticipantId;
  createdAt: number;        // epoch ms
}

export interface Member {
  channelId: string;
  participantId: ParticipantId;
  role: MemberRole;
  addedAt: number;          // epoch ms
}

export interface Message {
  id: string;               // "msg_" + 24 hex
  channelId: string;
  authorId: ParticipantId;
  content: string;
  replyTo?: string;         // message id (thread parent); undefined = root
  editedAt?: number;        // set by editMessage
  deletedAt?: number;       // soft-delete tombstone; content blanked to "" on delete
  createdAt: number;        // epoch ms
}

export interface ThreadView {
  root: Message;
  replies: Message[];       // ordered by createdAt asc, excludes deleted unless includeDeleted
}

export interface SearchHit {
  message: Message;
  channelId: string;
  snippet: string;          // FTS5 snippet() with <mark> highlights
  rank: number;             // bm25, lower = better
}
```

### 1.2 Store class (`packages/table/store.ts`)

```ts
export interface TableStoreOptions {
  dbPath?: string;          // default ~/.8gent/table/table.db
  ledger?: Ledger;          // injected; default opens the shared goal ledger (§1.4)
}

export class TableStore {
  constructor(opts?: TableStoreOptions);

  // --- channels ---
  createChannel(input: {
    name: string; type: ChannelType; visibility: Visibility;
    topic?: string; createdBy: ParticipantId;
  }): Channel;                                    // ledger: table.channel.create
  listChannels(opts?: {
    visibleTo?: ParticipantId;                    // filters private channels to members
  }): Channel[];
  getChannel(channelId: string): Channel | null;

  // --- members ---
  addMember(input: {
    channelId: string; participantId: ParticipantId; role: MemberRole;
    addedBy: ParticipantId;                       // must be owner/admin of channel
  }): Member;                                     // ledger: table.member.add
  removeMember(channelId: string, participantId: ParticipantId, removedBy: ParticipantId): void; // ledger: table.member.remove
  listMembers(channelId: string): Member[];
  isMember(channelId: string, participantId: ParticipantId): boolean;

  // --- messages (soft-delete throughout) ---
  postMessage(input: {
    channelId: string; authorId: ParticipantId; content: string; replyTo?: string;
  }): Message;                                    // ledger: table.message.post
  editMessage(input: {
    messageId: string; editorId: ParticipantId; content: string;
  }): Message;                                    // authorId must equal editorId; ledger: table.message.edit
  deleteMessage(input: {
    messageId: string; deleterId: ParticipantId;  // author OR channel owner/admin
  }): Message;                                    // sets deletedAt, blanks content; ledger: table.message.delete
  getThread(messageId: string, opts?: { includeDeleted?: boolean }): ThreadView | null;
  listMessages(channelId: string, opts?: {
    limit?: number;          // default 50, max 200
    before?: number;         // createdAt cursor (keyset pagination, desc then reversed)
    includeDeleted?: boolean;// default false
  }): Message[];             // ascending createdAt
  search(query: string, opts?: {
    channelId?: string; limit?: number;           // default 20
  }): SearchHit[];           // FTS5 MATCH, excludes deleted

  close(): void;
}
```

**Membership/authority rules enforced in the store (not the caller):**
- `postMessage`/`editMessage`/`deleteMessage`/`getThread`/`listMessages` all reject when `authorId`/reader is not a member of an `open`-visibility... *(clarify)* → members-only enforcement applies to **private** channels; `open` channels are readable by any known participant but still writable only by members. Throw `TableAuthError` on violation.
- `editMessage`: only the original author. `deleteMessage`: author, or channel `owner`/`admin`.
- `replyTo` must reference a message in the same channel; else `TableValidationError`.
- Channel `name` unique (SQLite UNIQUE); duplicate → `TableConflictError`.

Errors: `TableError` base, subclasses `TableAuthError | TableValidationError | TableConflictError | TableNotFoundError`, each with a stable `.code` string for WS error frames (§3.8).

### 1.3 Schema (`packages/table/schema.sql`, applied on open, `IF NOT EXISTS`)

```sql
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, type TEXT NOT NULL,
  visibility TEXT NOT NULL, topic TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  channel_id TEXT NOT NULL, participant_id TEXT NOT NULL, role TEXT NOT NULL, added_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, participant_id),
  FOREIGN KEY (channel_id) REFERENCES channels(id)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, author_id TEXT NOT NULL,
  content TEXT NOT NULL, reply_to TEXT, edited_at INTEGER, deleted_at INTEGER, created_at INTEGER NOT NULL,
  FOREIGN KEY (channel_id) REFERENCES channels(id)
);
CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_reply ON messages(reply_to);
CREATE INDEX IF NOT EXISTS idx_members_participant ON members(participant_id);

-- FTS5 mirror (external-content pattern like memory store)
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content, content='messages', content_rowid='rowid'
);
-- sync triggers (skip tombstoned content)
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
```

### 1.4 Ledger integration (reuse `packages/goal/ledger.ts` directly)

Every mutating store call appends **before returning** (write-then-append inside one method; if append throws, the method throws and the caller sees failure — the SQLite row is the source of truth, the ledger is the tamper-evident audit trail):

```ts
ledger.append({ kind: "table.<entity>.<op>", payload: canonicalizablePayload });
```

Payloads are the minimal record identity (never full mutable content beyond what defines the act):
- `table.channel.create` → `{ channelId, name, type, visibility, createdBy, createdAt }`
- `table.member.add` → `{ channelId, participantId, role, addedBy, addedAt }`
- `table.member.remove` → `{ channelId, participantId, removedBy, ts }`
- `table.message.post` → `{ messageId, channelId, authorId, replyTo: replyTo ?? null, contentHash, createdAt }`
- `table.message.edit` → `{ messageId, editorId, contentHash, editedAt }`
- `table.message.delete` → `{ messageId, deleterId, deletedAt }`

`contentHash = sha256(content)` — the ledger records *that* content existed and *when*, without duplicating the mutable body (privacy + smaller chain). Full text lives in `table.db`. `GoalEventKind` in `packages/goal` gets the six `table.*` string kinds added to its accepted set (the ledger already accepts `GoalEventKind | string`, so this is a documentation/typing widen, not a hard dependency).

---

## 2. Identity API (`packages/table/identity.ts`)

Ed25519 per participant. **Library decision:** use Node/Bun built-in `node:crypto` — Bun ships ed25519 via `crypto.generateKeyPairSync("ed25519")`, `crypto.sign(null, msg, privKey)`, `crypto.verify(null, msg, sig, pubKey)`. **No new dependency** (`@noble/ed25519` is NOT currently in `package.json`; do not add it). Keys stored as PEM (PKCS8 private / SPKI public).

- **Human keys** custodied silently at `~/.8gent/table/keys/<handle>.ed25519` (private, `0600`) + `.pub`. Minted lazily on first human post; the human never sees a prompt.
- **Agent keys** minted by the daemon at session bind, at `~/.8gent/table/keys/agent-<agentId>.ed25519`, same perms.

```ts
export interface Identity {
  participantId: ParticipantId;    // "human:james" | "agent:<agentId>"
  publicKeyPem: string;
}
export interface KeyDir { root: string; }  // default ~/.8gent/table/keys

export function mintIdentity(participantId: ParticipantId, dir?: KeyDir): Identity;   // generates + persists 0600, idempotent
export function loadIdentity(participantId: ParticipantId, dir?: KeyDir): Identity | null;
export function ensureIdentity(participantId: ParticipantId, dir?: KeyDir): Identity;  // load or mint
export function signMessage(participantId: ParticipantId, message: string, dir?: KeyDir): string; // base64 sig
export function verifyMessage(participantId: ParticipantId, message: string, sigB64: string, dir?: KeyDir): boolean;
export function publicKeyOf(participantId: ParticipantId, dir?: KeyDir): string | null;
```

**Where signatures ride:** `postMessage` optionally accepts a `sig` (per-message ed25519 over `canonical({channelId, authorId, content, replyTo, createdAt})`). Phase 1 records the author's `contentHash` in the ledger (HMAC-chain is the integrity spine); the ed25519 per-message signature is stored in a `messages.sig` column *(add nullable column to schema)* for future non-repudiation and cross-node federation. Not gate-critical in Phase 1 but the identity module must exist and be wired so every post is signable. **This does not replace the goal-ledger HMAC** — the two layers stack (ledger = ordered tamper-evidence, ed25519 = per-author attribution).

---

## 3. Daemon WS frames (added to `packages/daemon/gateway.ts` default route)

All frames flow over the existing `Bun.serve` WS on `127.0.0.1:18789`, after the client has sent `{type:"auth"}`. New frames are added as `case` arms in the `switch (msg.type)` in `handleMessage`. They carry `protocol_version: 1`. Table frames are **channel-scoped**, not session-scoped: the gateway maintains a new per-connection `subscribedChannels: Set<string>` on the socket state, and a `broadcastToChannel(channelId, frame)` helper parallel to the existing `broadcastToSession`.

Auth actor: the connection declares its participant via the auth frame extension `{ type:"auth", token, participantId }`. The daemon then **binds and PINS** that participant for the life of the connection (`bindParticipant`): only a `human:<handle>` id is accepted (agent ids are daemon-minted, never client-declared), and a second/different declaration on the same socket is rejected - so one connection can never post as arbitrary different participants. Binding exercises the ed25519 identity module on the live path (`ensureIdentity` custodies the key). A `message:post` MAY carry an ed25519 `sig` (+ the `createdAt` it signed over); when present it MUST verify against the pinned participant's public key or the frame is refused. All Table mutations use the pinned `participantId` as the actor. This is the trust boundary - **not** the daemon's bind address, since the global bind may be `0.0.0.0`; Table's off-box protection is the per-frame loopback guard above.

Request frames use `id` (client-generated correlation string). The daemon replies with a frame carrying the same `id`. Errors use §3.8.

### 3.1 `channel:create`
```jsonc
// → request
{ "type":"channel:create", "id":"c1", "name":"design", "channelType":"stream",
  "visibility":"open", "topic":"UI work" }
// ← response
{ "type":"channel:created", "id":"c1", "channel": { /* Channel */ } }
```

### 3.2 `channel:list`
```jsonc
// → { "type":"channel:list", "id":"c2" }
// ← { "type":"channel:listed", "id":"c2", "channels":[ /* Channel[] visible to actor */ ] }
```

### 3.3 `channel:members`
```jsonc
// → { "type":"channel:members", "id":"c3", "channelId":"chan_..." }        // list
// ← { "type":"channel:membersList", "id":"c3", "channelId":"chan_...", "members":[ /* Member[] */ ] }
// mutate (add): { "type":"channel:members", "id":"c4", "channelId":"chan_...",
//                 "op":"add", "participantId":"agent:8EO", "role":"bot" }
// ← { "type":"channel:memberAdded", "id":"c4", "member": { /* Member */ } }
// mutate (remove): { ..., "op":"remove", "participantId":"agent:8EO" }
// ← { "type":"channel:memberRemoved", "id":"c4", "channelId":"chan_...", "participantId":"agent:8EO" }
```

### 3.4 `message:post`
```jsonc
// → { "type":"message:post", "id":"m1", "channelId":"chan_...", "content":"hi @8EO",
//     "replyTo":"msg_..." /* optional */ }
// ← { "type":"message:posted", "id":"m1", "message": { /* Message */ } }
```
Side effects, in order: (1) `store.postMessage` (+ ledger append); (2) `broadcastToChannel(channelId, {type:"message:appended", message})` to every subscribed connection; (3) **@mention scan** (§3.7).

### 3.5 `message:edit`
```jsonc
// → { "type":"message:edit", "id":"m2", "messageId":"msg_...", "content":"..." }
// ← { "type":"message:edited", "id":"m2", "message": { /* Message */ } }
// broadcast: { "type":"message:updated", "message": { ... } }
```

### 3.6 `message:delete`
```jsonc
// → { "type":"message:delete", "id":"m3", "messageId":"msg_..." }
// ← { "type":"message:deleted", "id":"m3", "messageId":"msg_...", "deletedAt": 1234 }
// broadcast: { "type":"message:removed", "messageId":"msg_...", "deletedAt": 1234 }
```

### 3.7 `message:subscribe` / `message:unsubscribe` + streamed `message:appended`
```jsonc
// → { "type":"message:subscribe", "id":"s1", "channelId":"chan_...", "seed": 50 /* optional backfill */ }
// ← { "type":"message:subscribed", "id":"s1", "channelId":"chan_...",
//     "backlog":[ /* last `seed` Message[], asc */ ] }
// then, live, for every new post in that channel:
// ← { "type":"message:appended", "channelId":"chan_...", "message": { /* Message */ } }
// unsubscribe: { "type":"message:unsubscribe", "id":"s2", "channelId":"chan_..." }
//              ← { "type":"message:unsubscribed", "id":"s2", "channelId":"chan_..." }
```
`message:updated` / `message:removed` are pushed on the same channel subscription for edits/deletes.

### 3.8 `@mention → agent` flow (the core loop)

On every `message:post`, the gateway runs `scanMentions(content)` → list of `@handle` tokens → resolves each to an **agent member** of that channel (`store.listMembers` where `role` in {`member`,`bot`} and `participantId === "agent:"+handle`). For each matched agent:

1. **Announce activity** to subscribers: `broadcast {type:"agent:activity", channelId, agentId, state:"thinking"}` (drives the SR live-region in Flow).
2. Ensure a daemon session for that agent on the **`table` channel** (`pool.hasSession(tableSessionId(channelId, agentId))` else `pool.createSession(sid, "table", { agentScope, allTools:false })`).
3. Build the **untrusted-input-safe** prompt: the raw message is passed as *content to respond to*, never interpolated into a command. It is handed to `pool.chat(sid, promptEnvelope)` where `promptEnvelope` wraps it as data (`{ role:"channel_message", channelId, from, text }` serialized), and the agent's system context states it may reply ONLY by calling the `post_to_channel` tool.
4. The agent's model runs **local only** (`eight:latest` / ollama). It calls `post_to_channel` (§4), which is ToolG8-gated, writes via the same `TableStore.postMessage` (authorId = `agent:<agentId>`), and thus emits its own `message:appended` broadcast + ledger entry.
5. On turn end: `broadcast {type:"agent:activity", channelId, agentId, state:"idle"}`.

**Frames added, summary:** `channel:create` `channel:created` · `channel:list` `channel:listed` · `channel:members` `channel:membersList` `channel:memberAdded` `channel:memberRemoved` · `message:post` `message:posted` · `message:edit` `message:edited` · `message:delete` `message:deleted` · `message:subscribe` `message:subscribed` · `message:unsubscribe` `message:unsubscribed` · `message:appended` `message:updated` `message:removed` · `agent:activity`.

### 3.9 Error frame (all Table failures)
```jsonc
{ "type":"table:error", "id":"<echoed>", "code":"TABLE_AUTH|TABLE_VALIDATION|TABLE_CONFLICT|TABLE_NOT_FOUND|TABLE_INTERNAL",
  "message":"human-readable, no secrets" }
```

---

## 4. `post_to_channel` agent tool + ToolG8 gating

New tool registered for `table`-channel sessions only (added to the agent's toolset when `createSession(..., "table", ...)`; NOT in the global default toolset). The agent has **no shell / run_command tool** in this scope.

### 4.1 Tool signature (`packages/table/tools/post-to-channel.ts`)
```ts
export interface PostToChannelInput {
  channelId: string;   // must be a channel the agent is a member of
  content: string;     // the reply text
  replyTo?: string;    // optional thread parent
}
export interface PostToChannelResult {
  ok: boolean;
  messageId?: string;
  error?: string;      // gate-deny or validation reason
}

// Factory binds the store + the acting agentId at session-build time.
export function makePostToChannelTool(deps: {
  store: TableStore;
  agentId: string;               // "agent:<id>"
  broadcast: (channelId: string, frame: unknown) => void;
}): AgentTool<PostToChannelInput, PostToChannelResult>;
```

### 4.2 Gating (every call, no exceptions)
Inside the tool's `execute`, BEFORE any store write:
```ts
const gate = ToolG8.instance().gate(agentId, "channel_post", {
  channelId: input.channelId,
  targetTable: "messages",
  contentLength: input.content.length,
});
if (!gate.allowed) return { ok:false, error: gate.reason };
// membership re-check (defense in depth): store.isMember(channelId, agentId) else deny
const msg = store.postMessage({ channelId: input.channelId, authorId: agentId,
                                content: input.content, replyTo: input.replyTo });
broadcast(input.channelId, { type:"message:appended", channelId: input.channelId, message: msg });
return { ok:true, messageId: msg.id };
```

- `channel_post` is a **new policy action string** (the policy engine already accepts `PolicyActionType | string`). No enum edit required, but it MUST be documented in `policy-engine.ts` alongside the network/command actions.
- Audited automatically to `~/.8gent/audit/toolg8.jsonl` by `ToolG8.audit`.

### 4.3 Restricted scope + explicit allow (deny-by-default)
Table agents bind with a restricted `agentScope`. Two-part policy, installed once at daemon boot in the Table wiring module:
```ts
// 1) catch-all block for table agents (deny by default)
addPolicy({ name:"table-agent-deny-all", action:"*", effect:"block",
  condition:{ agentScope:"__table__" }, immutable:false });
// 2) explicit narrow allow — ONLY channel_post, ONLY to channels they belong to
addPolicy({ name:"table-agent-allow-post", action:"channel_post", effect:"allow",
  condition:{ agentScope:"__table__" } });
```
`network_request`, `run_command`, `write_file`, secrets remain blocked — the existing `__spawned__` immutable blocks (spawned-no-network etc.) are the model; Table reuses that shape. **No `bypassPermissions` path is introduced.** Cloud model use stays off unless `EIGHT_TABLE_CONSENT_CLOUD=1` is set AND the consent is written to the ledger (`table.consent.cloud`); default is local model, full stop.

---

## 5. File plan

### 5.1 New files — `packages/table/` (backend, `/Users/jamesspalding/8gent-code`)
```
packages/table/
  SPEC.md                       (this file)
  package.json                  name "@8gent/table", bun, no new runtime deps
  index.ts                      barrel: re-exports store, types, identity, tools, wiring
  types.ts                      §1.1 domain types + error classes
  schema.sql                    §1.3
  store.ts                      §1.2 TableStore (bun:sqlite + FTS5 + ledger append)
  identity.ts                   §2 ed25519 via node:crypto
  ids.ts                        chan_/msg_ id minting (crypto.randomUUID → hex)
  mentions.ts                   scanMentions(content) → handle[]
  wiring.ts                     installTablePolicies(); tableSessionId(); mention router
  tools/post-to-channel.ts      §4 gated tool factory
  __tests__/store.test.ts       CRUD + soft-delete + FTS + ledger-append assertions
  __tests__/identity.test.ts    mint/load/sign/verify roundtrip, 0600 perms
  __tests__/policy.test.ts      channel_post allowed, run_command/network denied for __table__
  __tests__/mentions.test.ts    mention scan + membership resolution
```

### 5.2 New files — `8gent-flow/src/routes/table/` (desktop UI)
```
src/routes/table/
  register.ts                   registerPane({ path:"/table", label:"Table",
                                  component: TableView, order:25 }) from "../registry"
  TableView.tsx                 exported pane: channel sidebar + message list + composer
  useTableChannels.ts           daemon WS: channel:list + live channel roster
  useTableThread.ts             message:subscribe fold + message:post send (models on chat/useChatThread.ts)
  model.ts                      Flow-side Channel/Message view models + agentActivity state
  daemonSocket.ts               configurable LOCAL daemon WS (default ws://127.0.0.1:18789,
                                  from import.meta.env.VITE_DAEMON_WS_URL); graceful "daemon offline"
                                  empty state, announced via aria-live
  TableView.test.tsx            renders offline state + folds a message:appended frame
```
UI rules: **only `--flow-*` CSS vars** (green #22c55e default, dark + light toggle). No hardcoded colors, no `#E8610A`, no purple (hues 270–350). Keyboard operable; `aria-live="polite"` region announces new messages and `agent:activity` state changes (8DO Legible Agents). Reuse `src/routes/chat/` bubble/composer patterns and `src/routes/waiting/WaitingPane.tsx` as the channel-sidebar template.

### 5.3 Existing files — the Wire step edits (surgical)
```
packages/daemon/agent-pool.ts   KNOWN_CHANNELS: add "table" (the const array ~line 45)
                                + optional CHANNEL_CAPS["table"] / idle timeout entry.
packages/daemon/types.ts        DaemonChannel union: add | "table".
packages/daemon/gateway.ts      handleMessage switch: add the Table case arms (§3);
                                add per-connection subscribedChannels Set + broadcastToChannel;
                                on boot call installTablePolicies() and construct the shared TableStore.
packages/goal/ (types)          widen accepted GoalEventKind set to document the six table.* kinds
                                (ledger already accepts string; typing-only).
8gent-flow/src/routes/panes.ts  add ONE line: import "./table/register";
8gent-flow/src/components/paneIcons.ts  (optional) ICONS["/table"] = <Glyph/>.
```
**Do NOT edit** in Flow: `App.tsx`, `Dock`, `SidebarDrawer`, `PaneSheet` — the pane registry drives them. **Do NOT** introduce a remote relay host; Table points at the local daemon only.

---

## 6. Build order (for the parallel builders)

1. **Store + identity + schema** (`packages/table/*`, no daemon) — testable in isolation against a temp DB + temp keydir. Gate: `bun test packages/table` green.
2. **Policy + tool** (`wiring.ts`, `tools/post-to-channel.ts`) — gate: `policy.test.ts` proves deny-by-default + single allow.
3. **Daemon frames** (gateway/agent-pool/types edits) — gate: a WS smoke test creates a channel, posts, receives `message:appended`, @mentions an agent member, observes an agent `post_to_channel` reply + ledger growth. `verify()` on the ledger passes.
4. **Flow pane** — gate: `bun run` Flow, `/table` renders, offline state is accessible, a live post folds in. Reuses only `--flow-*` tokens.

Each step is one branch → PR → `Closes #<issue>`; no direct pushes to main; `bun test` (backend) / Flow vitest must pass before merge.

---

## 7. Security bar checklist (8SO — must all be true at merge)

- [ ] No `bypassPermissions` anywhere in Table code paths.
- [ ] Agent posts go through `ToolG8.instance().gate(agentId, "channel_post", …)`; run_command/network/write_file denied for `__table__` scope (test-proven).
- [ ] Inbound channel content is passed to the agent as *data envelope*, never string-interpolated into a shell/tool command.
- [ ] Local model only; cloud requires `EIGHT_TABLE_CONSENT_CLOUD=1` + a `table.consent.cloud` ledger entry.
- [ ] Every human/agent post appends a signed entry to the goal ledger; `ledger.verify()` walks clean.
- [ ] No new listener. Global bind is `DAEMON_HOSTNAME` (default `0.0.0.0`); Table `channel:*`/`message:*` frames are enforced loopback-only by a per-frame guard (`isLoopbackAddress`), so Table stays off-box-unreachable regardless of the global bind.
- [ ] Key files `0600`; keys never leave `~/.8gent/table/keys/`; no key material in logs, WS frames, or ledger payloads (only public keys + content hashes).
