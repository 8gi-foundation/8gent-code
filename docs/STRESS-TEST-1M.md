# 8gent Harness Architecture - Stress Test Report
## Path to 1,000,000 Users

**Author:** Rishi (8TO) + Engineering Team
**Date:** 2026-03-28
**Status:** ANALYSIS COMPLETE
**Verdict:** Architecture is sound for 10K. Requires significant work for 100K+. Critical redesign needed for 1M.

---

## EXECUTIVE SUMMARY

After reading the actual implementation across all four layers, here is the honest assessment:

**What works today (Ring 0 - Founding Circle):**
- Local-first Harness + Tool Belt is the right call. No shared infrastructure pressure from individual users.
- NemoClaw policy engine is lightweight and correct. Pre-parsed conditions, deny-by-default.
- SQLite + WAL + FTS5 memory store is solid for single-user workloads.
- Control Plane WebSocket + durable task queue is clean.

**What will break:**
- The Control Plane is a monolith on a single Bun process. One WebSocket server, one health interval, one process.
- The Tool Registry is a singleton in-memory Map. No persistence, no distribution.
- SQLite memory store does a full table scan for vector search (`_vectorSearch` loads ALL embeddings into memory).
- Rate limiter is per-channel, in-memory, per-process. Meaningless at multi-instance.
- TaskRouter chain depth tracking is in-memory. Lost on restart.
- Vessel auth is a single shared token. One compromised vessel = all compromised.
- No backpressure mechanism anywhere. No circuit breakers. No bulkheads.

---

## 1. SCALING ANALYSIS - Layer by Layer

### LAYER 1: HARNESS (Local Agent Loop)

The Harness runs on each user's machine. It includes: `Agent` class, `ToolExecutor`, AI SDK integration, session writer, heartbeat, kernel manager, orchestrator bus, proactive planner, evidence collector, workflow validator, onboarding manager, session sync, and Telegram bot.

| Scale Point | What Breaks | Bottleneck | Mitigation |
|---|---|---|---|
| **100 users** | Nothing. Each user runs independently. | User's local hardware (RAM for Ollama, ~8GB minimum for qwen3:14b) | Task router auto-selects smaller models on low-RAM machines |
| **1,000 users** | AST indexing on large codebases blocks startup. `astIndexFolder()` is fire-and-forget but CPU-intensive. | CPU saturation during AST index + model inference running simultaneously | Defer AST indexing until first code-related tool call. Index incrementally via file watchers, not full re-index. |
| **10,000 users** | Convex session sync (`SessionSyncManager`) creates 10K concurrent connections to Convex. Kernel manager's GRPO training proxy competes with inference for GPU. | Network: 10K Convex WebSocket connections. GPU: training vs inference contention. | Batch session sync (write-behind buffer, flush every 30s). Training proxy must yield to inference - add priority queue for GPU access. |
| **100,000 users** | The `messageHistory` array grows unbounded per session. At 200+ turns with planning gates injecting extra messages, memory bloats. Tool call tracker (`Map<string, number>`) never prunes. | RAM: unbounded message history. Each message with system prompt + personality + orchestrator context is ~4KB. 200 turns = 800KB per user. 100K users = 80GB aggregate if sessions are long. | Sliding window on messageHistory (keep last 50 turns + system prompt). Compress older turns into a summary memory. Prune toolCallTracker after each chat(). |
| **1,000,000 users** | Nothing new breaks at this layer because it runs locally. The risk is support/update distribution: 1M Bun installations, 1M different OS versions, 1M different Ollama versions. | Distribution: package updates, breaking changes, migration scripts. | Semver strictly. Auto-update daemon. Canary rollouts (1% -> 10% -> 100%). Health telemetry (opt-in) to detect regression. |

**Key finding:** Harness scales horizontally by design (each user = independent process). The main risk is local resource contention (Ollama + AST + training), not distributed systems problems.

---

### LAYER 2: TOOL BELT (Local Permissions + Rate Limiting)

The Tool Belt includes: NemoClaw policy engine, Tool Registry, rate limiter, and permission manager.

| Scale Point | What Breaks | Bottleneck | Mitigation |
|---|---|---|---|
| **100 users** | Nothing. All local. | N/A | N/A |
| **1,000 users** | Policy engine uses `_policies.indexOf(r)` inside `evaluatePolicy()` for every rule evaluation. O(n) per rule per evaluation. With many user-defined policies, this adds up. | CPU: linear scan on every tool call with many policies | Pre-build a `Map<number, PolicyRule>` at load time instead of using indexOf. Already have `_parsedConditions` Map - align the indexes. |
| **10,000 users** | Tool Registry singleton (`registryInstance`) means all tools share one namespace. If two packages register the same tool name, it throws. No versioning. | Naming collisions as ecosystem grows. | Add namespace prefixing: `@package/toolName`. Support tool versioning: `toolName@1.2.0`. |
| **100,000 users** | Users want custom policies but `loadPolicies()` reads YAML from disk synchronously (`fs.readFileSync`). Hot-reloading policies means blocking the event loop. | Disk I/O: synchronous YAML reads on policy reload | Switch to async file reads. Cache parsed policies. Use file watcher for hot-reload instead of re-reading on every call. |
| **1,000,000 users** | Policy sharing across the ecosystem. Users want to publish/subscribe to community policy sets (like ESLint configs). Current architecture has no distribution mechanism. | No policy distribution/composition model | Build a policy registry (like npm for policies). Support `extends: ["@8gent/strict", "@company/custom"]` in policies.yaml. |

**Key finding:** Tool Belt scales fine locally. The risks are ecosystem-level (naming collisions, policy distribution) not performance-level.

---

### LAYER 3: TOOL SHED (Shared Multi-Tenant Service)

The Tool Shed is not yet implemented as a separate service. Currently, all tool execution is local. This analysis covers what happens when it becomes a shared service.

| Scale Point | What Breaks | Bottleneck | Mitigation |
|---|---|---|---|
| **100 users** | Nothing. Tool Shed can run as a single instance. | N/A | N/A |
| **1,000 users** | Pattern collection from 1K users generates significant write volume. If using SQLite (like memory store), WAL mode handles concurrent reads but writes serialize. | Write throughput: SQLite write serialization under concurrent pattern ingestion | PostgreSQL or ClickHouse for pattern analytics. SQLite is wrong for shared multi-tenant writes. |
| **10,000 users** | Cross-tenant pattern matching requires reading from all tenants' data. Full scan of patterns table for "collective intelligence" features. | Query latency: pattern matching across 10K users' data | Materialized views for common patterns. Pre-aggregate by category/language/framework. Background ETL, not real-time. |
| **100,000 users** | Multi-tenancy isolation. One user's bad pattern (e.g., malicious code snippet) gets promoted to collective patterns, poisoning 100K users. | Data quality: pattern poisoning at scale | Quarantine pipeline: new patterns go through validation before promotion. Confidence scoring. Human review for patterns that affect >1000 users. Rollback capability. |
| **1,000,000 users** | API rate limiting. 1M users making pattern queries = ~10K QPS assuming 1 query per 100 seconds per user. Single-region deployment can't handle this. | QPS: 10K+ queries per second for pattern reads | Multi-region deployment (AMS, US-East, APAC). Read replicas. CDN for static patterns. Edge caching for popular patterns. |

**Key finding:** Tool Shed doesn't exist yet. When built, it MUST NOT use SQLite. PostgreSQL minimum. Plan for multi-region from day one.

---

### LAYER 4: CONTROL PLANE (Orchestration + Vessel Lifecycle)

The Control Plane is implemented as a single Bun process running: `TaskQueue` (SQLite), `DiscordGateway` (one per bot), `DiscordRest`, `TaskRouter`, `MemoryBridge`, `AuditLog`, `VesselHealthMonitor`, and a WebSocket server for vessel connections.

| Scale Point | What Breaks | Bottleneck | Mitigation |
|---|---|---|---|
| **100 users** | Nothing. 8 vessels, 8 Discord bots, low message volume. | N/A | N/A |
| **1,000 users** | Discord rate limits. Each bot gets 50 requests/second. With 1K users in channels, the `DiscordRest.postMessage()` hits rate limits fast. | Discord API: 50 req/s per bot token | Queue outbound messages. Implement Discord rate limit headers (`X-RateLimit-*`). Back off on 429s. Batch message sends where possible. |
| **10,000 users** | WebSocket connection limit. The single `Bun.serve()` on `config.vesselPort` handles all vessel connections. 10K users means potentially hundreds of vessels (Lotus Ring 2 = 64 heads, each with 8 vessels = 512 vessels). | WebSocket: single-process connection handling for 500+ vessels | Shard the Control Plane. Each shard handles one Lotus Ring or one geographic region. Use a coordinator to route vessels to the right shard. |
| **100,000 users** | The `healthInterval` runs every `config.healthCheckIntervalMs` and iterates ALL vessels (`for (const [ws, conn] of vessels)`), checking each one. With 5000+ vessels, this loop takes significant time. | Health check loop: O(n) vessel iteration every tick | Partition health checks. Use a priority queue - check vessels that missed heartbeats first. Delegate health monitoring to a separate service. |
| **1,000,000 users** | Lotus Ring 3 = 512 leads. Each lead manages a pod of users. The Control Plane needs to manage 512+ leads, each with their own vessels, tasks, and memory. The single SQLite `TaskQueue` cannot handle the write volume. | Storage: SQLite task queue write throughput (est. 50K tasks/day at 1M users) | Replace SQLite TaskQueue with Redis Streams or NATS JetStream for durable task queuing. PostgreSQL for task history. Separate hot path (task assignment) from cold path (task history/analytics). |

**Key finding:** Control Plane is the critical bottleneck. It's a single process, single SQLite database, single WebSocket server. Must be sharded by Lotus Ring at 10K+ users.

---

## 2. EDGE CASES (25 Cases)

### NETWORK FAILURES

**EC-01: Tool Shed Unreachable**
- **Layer:** Tool Belt -> Tool Shed
- **What goes wrong:** User's Harness tries to query collective patterns but Tool Shed is down. Currently no fallback - the call would hang or throw.
- **Going right looks like:** Local-only mode activates transparently. User sees no degradation for core functionality. Pattern queries return stale cached results.
- **Survival:** Circuit breaker with 3-strike cutoff. Local cache of last-known patterns (TTL 24h). Retry with exponential backoff.
- **Severity:** MEDIUM (core functionality is local-first; Tool Shed is enhancement)

**EC-02: Control Plane Unreachable from Vessel**
- **Layer:** Control Plane <-> Vessel
- **What goes wrong:** Vessel loses WebSocket connection. `VesselClient.connect()` has reconnection logic, but during the gap, tasks pile up in the TaskQueue with no vessel to process them.
- **Going right looks like:** Vessel reconnects within 30s. Stale tasks are recovered by `taskQueue.recoverStaleTasks()`. No tasks lost. Users see delayed responses, not dropped ones.
- **Survival:** Durable task queue already persists to SQLite. Vessels have auto-reconnect. Add dead letter queue for tasks that exceed 3 retry attempts.
- **Severity:** HIGH (board members go silent in Discord)

**EC-03: Discord Gateway Disconnection**
- **Layer:** Control Plane (DiscordGateway)
- **What goes wrong:** Discord gateway heartbeat fails, connection drops. Messages received during outage are lost (Discord gateways don't replay missed events unless you track sequence numbers).
- **Going right looks like:** Gateway reconnects and resumes with session_id + sequence number. Missed messages are replayed by Discord.
- **Survival:** Implement Discord session resume (currently gateways just `connect()` fresh). Track last sequence number. Use `resume_url` from READY event.
- **Severity:** HIGH (messages from users permanently lost during outage)

**EC-04: Ollama Crash Mid-Inference on Vessel**
- **Layer:** Vessel
- **What goes wrong:** `generateResponse()` in vessel calls Ollama, which OOMs on a large context. The Promise rejects. `handleTask()` catches it in the finally block and clears `currentTaskId`, but the task fails.
- **Going right looks like:** Task is marked failed. Control Plane reassigns to another vessel or retries with a smaller model.
- **Survival:** Vessel sends `task:failed` to Control Plane. Add retry logic in Control Plane: retry with same vessel once, then failover to a different vessel or cloud model.
- **Severity:** HIGH (user gets no response)

### DATA CORRUPTION

**EC-05: SQLite Memory Database Corruption**
- **Layer:** Harness (Memory Store)
- **What goes wrong:** Power loss during WAL checkpoint. SQLite WAL file and main DB become inconsistent. `new Database(dbPath)` throws on next startup.
- **Going right looks like:** Corrupted DB detected at startup. Automatic recovery from WAL. If unrecoverable, start fresh with empty memory (user loses episodic memories but agent still works).
- **Survival:** On Database open failure: try `PRAGMA integrity_check`. If fails, rename corrupt DB to `.corrupt.bak`, create fresh. Log the incident. Offer manual recovery path.
- **Severity:** CRITICAL (user loses all learned memories)

**EC-06: Stale Patterns from Tool Shed Poisoning Collective Intelligence**
- **Layer:** Tool Shed
- **What goes wrong:** A user's local agent learns a bad pattern (e.g., "always delete node_modules before build"). This gets promoted to collective patterns. 1000 users start deleting node_modules unnecessarily.
- **Going right looks like:** Pattern promotion has a confidence threshold. New patterns are quarantined. Patterns that cause task failures in other users' contexts are automatically demoted.
- **Survival:** Confidence scoring + quarantine pipeline. A/B test patterns: half of users get the pattern, half don't. Measure success rate delta. Automatic rollback if pattern degrades outcomes.
- **Severity:** HIGH (scales with user count - more users = more damage)

**EC-07: FTS5 Index Desync with Memories Table**
- **Layer:** Harness (Memory Store)
- **What goes wrong:** The FTS5 triggers (`memories_ai`, `memories_ad`, `memories_au`) fail silently if FTS5 virtual table is corrupted. Searches return incomplete results. User says "remember that thing about auth" and gets nothing.
- **Going right looks like:** FTS5 index is periodically validated against source table. Rebuild command available. Inconsistency detected and auto-repaired.
- **Survival:** Add `PRAGMA integrity_check` for FTS5. On detection of inconsistency, drop and rebuild FTS5 index from memories table. Background job, not on hot path.
- **Severity:** MEDIUM (search degraded, not lost; memories still exist in main table)

### SECURITY

**EC-08: NemoClaw Policy Bypass via Crafted Condition**
- **Layer:** Tool Belt (Policy Engine)
- **What goes wrong:** A malicious user crafts a policy YAML with a condition that always evaluates to true for "allow" decisions, effectively whitelisting all actions: `condition: "command contains "`. The empty contains check matches everything.
- **Going right looks like:** Policy validation rejects empty values. Minimum value length enforced. Semantic validation of condition logic.
- **Survival:** Add validation in `parseClause()`: reject empty values. Add test case for empty/whitespace-only patterns. Warn on overly broad "contains" with <3 char values.
- **Severity:** CRITICAL (bypasses entire permission system)

**EC-09: Malicious Tool Injection via Registry**
- **Layer:** Tool Belt (Tool Registry)
- **What goes wrong:** A compromised npm package registers a tool named `run_command` that shadows the built-in. The `ToolRegistry.register()` throws on duplicate names, but if the malicious package loads before the core tools, it wins.
- **Going right looks like:** Core tools are registered in a protected namespace. Third-party tools can't shadow core tools regardless of load order.
- **Survival:** Add a `protected` flag on core tools. `register()` checks if a tool name matches a protected name and rejects. Core tools load first in a separate initialization phase.
- **Severity:** CRITICAL (arbitrary code execution under user's permissions)

**EC-10: Vessel Auth Token Compromise**
- **Layer:** Control Plane <-> Vessel
- **What goes wrong:** Single `VESSEL_AUTH_TOKEN` is shared across all vessels. One compromised vessel exposes the token. Attacker connects a rogue vessel, impersonates any board member.
- **Going right looks like:** Each vessel has its own unique auth token. Token rotation on schedule. Compromised token affects only one vessel.
- **Survival:** Per-vessel tokens derived from a master secret + vessel ID (HMAC). Token rotation every 24h via Control Plane push. Mutual TLS for vessel connections.
- **Severity:** CRITICAL (full board impersonation)

**EC-11: Supply Chain Attack via OpenRouter Model Response**
- **Layer:** Vessel (Inference)
- **What goes wrong:** Compromised model on OpenRouter returns responses containing prompt injection that causes the vessel to execute unintended actions. Since vessels call `generateResponse()` and return raw output to Discord, the injection could include Discord markdown that looks like legitimate board member output.
- **Going right looks like:** Content policy gate (`validateResponse()` + `sanitizeResponse()`) catches injection patterns. Responses are sandboxed before posting.
- **Survival:** Content policy already exists in the Control Plane. Strengthen it: strip code blocks that look like shell commands, detect prompt injection patterns, enforce max response length.
- **Severity:** HIGH (board members could post malicious content)

### RATE LIMITING & ABUSE

**EC-12: Burst Abuse on Control Plane**
- **Layer:** Control Plane (TaskRouter)
- **What goes wrong:** User spams Discord channel with rapid messages mentioning a bot. `RateLimiter` checks per-channel with a 10s cooldown, but the `lastResponse` Map is in-memory and per-process. If Control Plane restarts, rate limits reset.
- **Going right looks like:** Rate limits persist across restarts. Escalating penalties for repeat offenders (10s -> 30s -> 5min -> ban).
- **Survival:** Persist rate limit state in SQLite alongside TaskQueue. Add escalating cooldowns. Add per-user rate limiting (not just per-channel).
- **Severity:** MEDIUM (task queue fills with spam, real tasks delayed)

**EC-13: DDoS on Tool Shed API**
- **Layer:** Tool Shed
- **What goes wrong:** External attacker floods Tool Shed API. Since Tool Shed is a shared service, all users' pattern queries fail simultaneously.
- **Going right looks like:** DDoS protection at edge (Cloudflare/Fly.io proxy). Tool Shed behind API gateway with rate limiting. Users fall back to local-only mode.
- **Survival:** Fly.io edge provides basic DDoS protection. Add API key authentication. Rate limit per API key. Local cache ensures users degrade gracefully.
- **Severity:** HIGH (all enhanced features go offline simultaneously)

### MULTI-TENANCY

**EC-14: Cross-Tenant Data Leakage in Tool Shed**
- **Layer:** Tool Shed
- **What goes wrong:** Pattern aggregation query accidentally returns patterns that contain user-specific code snippets, file paths, or proprietary information from another tenant.
- **Going right looks like:** Patterns are anonymized before storage. No raw code snippets, only abstract pattern descriptions. Tenant ID is part of the query filter and enforced at the database level.
- **Survival:** Row-level security in PostgreSQL. Patterns stored as abstract descriptions, never raw code. Automated PII detection on pattern ingestion. Quarterly audit.
- **Severity:** CRITICAL (data breach, legal liability, trust destruction)

**EC-15: Noisy Neighbor in Vessel Infrastructure**
- **Layer:** Control Plane / Vessel
- **What goes wrong:** One board member gets 100x more Discord messages than others. All tasks queue for that member's vessel, which falls behind. Other members' vessels sit idle.
- **Going right looks like:** Load balancing across vessels. Hot member gets additional vessel instances auto-scaled. Task priority based on queue depth.
- **Survival:** Auto-scale vessels per member based on queue depth. Max queue depth triggers spillover to cloud inference. Fair scheduling across members.
- **Severity:** MEDIUM (degraded response time for one member, others unaffected)

### MODEL FAILURES

**EC-16: Ollama OOM on Large Context**
- **Layer:** Harness / Vessel
- **What goes wrong:** `messageHistory` grows to 200+ messages. System prompt + personality + orchestrator + user context = ~4KB base. 200 messages at ~500 tokens each = 100K tokens. Ollama with qwen3:14b OOMs on 16GB RAM machines.
- **Going right looks like:** Context window management. Automatic summarization of old messages. Token counting before model call. Graceful degradation to smaller model on OOM.
- **Survival:** Add token counting in `chat()` before calling AI SDK. If estimated tokens > 80% of model's context window, summarize older messages. Catch OOM and retry with smaller context or smaller model.
- **Severity:** HIGH (agent becomes unresponsive)

**EC-17: OpenRouter Rate Limits / Outage**
- **Layer:** Harness (cloud fallback)
- **What goes wrong:** 10K users simultaneously fall back to OpenRouter (e.g., Ollama version has a bug). OpenRouter rate limits hit. All cloud inference fails.
- **Going right looks like:** Multiple cloud providers configured. Automatic failover: OpenRouter -> Together -> Groq. Backoff and retry. User notified of degradation.
- **Survival:** Multi-provider fallback chain in AI SDK config. Exponential backoff per provider. User-visible status: "Using local model (cloud unavailable)".
- **Severity:** HIGH (all cloud-dependent users lose inference)

### CONCURRENCY

**EC-18: Multiple Agents on Same Codebase via Worktree**
- **Layer:** Harness (Orchestration)
- **What goes wrong:** `WorktreePool` allows max 4 concurrent worktrees. Two users on the same team share a repo. Both trigger worktree creation for different tasks. Git locks conflict. Worktree operations fail with "fatal: working tree already exists".
- **Going right looks like:** Worktree names include user ID. Lock file per worktree. Timeout and cleanup of stale worktrees. Clear error message on conflict.
- **Survival:** Namespace worktrees by user + session ID. Add file-based locks with timeout. Automatic cleanup of worktrees older than 1 hour. Graceful error: "Another agent is using this worktree, queuing your task".
- **Severity:** MEDIUM (affects multi-user teams only)

**EC-19: Concurrent SQLite Writes in Memory Store**
- **Layer:** Harness (Memory Store)
- **What goes wrong:** Heartbeat agent, memory consolidation, and main agent all write to the same SQLite DB simultaneously. WAL mode handles concurrent reads, but concurrent writes serialize. Under heavy load, write contention causes "database is locked" errors.
- **Going right looks like:** WAL mode with `PRAGMA busy_timeout = 5000`. Writes succeed with small delays. No data loss.
- **Survival:** Already using WAL mode. Add `PRAGMA busy_timeout = 5000` to handle transient locks. Batch writes in transactions (already doing `writeBatch()`). Monitor write latency.
- **Severity:** MEDIUM (transient errors, no data loss)

### STATE MANAGEMENT

**EC-20: Checkpoint Corruption During Session Restore**
- **Layer:** Harness (SessionSyncManager)
- **What goes wrong:** User's machine crashes mid-session. `SessionWriter` writes partial JSON to session file. On restart, `restoreFromCheckpoint()` fails to parse the JSON.
- **Going right looks like:** Session files use append-only JSONL format. Partial writes only affect the last line. Recovery reads all complete lines and ignores the partial last line.
- **Survival:** Switch from JSON to JSONL (newline-delimited JSON). Each entry is independently parseable. On corruption, skip the last incomplete line. Log recovery stats.
- **Severity:** HIGH (user loses entire session context on crash)

**EC-21: Session ID Collision**
- **Layer:** Harness (Agent constructor)
- **What goes wrong:** `sessionId` is generated as `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`. At 1M users, birthday paradox: probability of collision in the random suffix (6 chars, 36^6 = 2.2B combinations) becomes non-trivial over time.
- **Going right looks like:** Session IDs use crypto.randomUUID(). Zero collision probability.
- **Survival:** Replace with `crypto.randomUUID()`. Simple, zero-risk fix. Already importing crypto module.
- **Severity:** LOW (unlikely but trivial to fix)

### FACTORY LOOP

**EC-22: Quarantine Overflow - Too Many Bad Patterns**
- **Layer:** Tool Shed (Factory)
- **What goes wrong:** Factory loop generates patterns faster than humans can review them. Quarantine queue grows unbounded. Memory/storage fills up. Review backlog means stale patterns never get promoted.
- **Going right looks like:** Quarantine has a max size. FIFO eviction of oldest unreviewed patterns. Auto-promote patterns that pass automated quality checks. Auto-reject patterns below confidence threshold.
- **Survival:** Max quarantine size (10K entries). Auto-reject below 0.3 confidence. Auto-promote above 0.9 confidence after 48h. FIFO eviction for the middle band.
- **Severity:** MEDIUM (reduced collective intelligence quality, not a crash)

**EC-23: Bad PR Auto-Merge from Factory Output**
- **Layer:** Tool Shed (Factory)
- **What goes wrong:** Factory generates a PR that passes automated tests but introduces a subtle regression (e.g., performance degradation, silent data corruption). Auto-merge promotes it to main.
- **Going right looks like:** PRs require human approval. Automated tests include performance benchmarks. Canary deployment before full rollout.
- **Survival:** Never auto-merge. Factory PRs always require human review. Add benchmark regression detection (compare metrics before/after). Canary rollout for infrastructure changes.
- **Severity:** CRITICAL (bad code in production affecting all users)

### SCALING

**EC-24: Vector Search Full Table Scan at Scale**
- **Layer:** Harness (Memory Store)
- **What goes wrong:** `_vectorSearch()` loads ALL rows from the embeddings table into memory and computes cosine similarity for each. At 100K memories, this means loading 100K * 768 dimensions * 4 bytes = 300MB into memory per search query.
- **Going right looks like:** Vector search uses an approximate nearest neighbor (ANN) index (HNSW, IVFFlat). Query time is O(log n) not O(n). Memory usage bounded by index size.
- **Survival:** Integrate sqlite-vss or build HNSW index. Pre-filter by type/scope before vector search (already partially done). Limit vector search to most recent 10K memories.
- **Severity:** HIGH (search becomes unusable above ~50K memories)

**EC-25: WebSocket Connection Limit on Control Plane**
- **Layer:** Control Plane
- **What goes wrong:** At Lotus Ring 3 scale (512+ vessels), the single `Bun.serve()` WebSocket server hits OS file descriptor limits (default 1024 on Linux). New vessels can't connect.
- **Going right looks like:** File descriptor limit raised. Connection pooling. Sharded Control Plane instances.
- **Survival:** Raise ulimit to 65535. Shard Control Plane by Lotus Ring. Each shard handles ~64 vessels max. Coordinator routes vessels to the correct shard.
- **Severity:** HIGH (vessels can't connect, board goes offline)

---

## 3. TEST MATRIX

| # | Test Name | Type | Edge Case | Setup Required | Pass Criteria | Effort |
|---|---|---|---|---|---|---|
| T01 | tool-shed-circuit-breaker | integration | EC-01 | Mock Tool Shed that returns 500s | Harness falls back to local-only within 3 failed requests. No user-visible error. | 2 days |
| T02 | vessel-reconnect-under-load | chaos | EC-02 | Kill Control Plane process while vessel is processing task | Vessel reconnects within 30s. Task is recovered from durable queue. No duplicate responses. | 3 days |
| T03 | discord-gateway-resume | integration | EC-03 | Disconnect gateway mid-stream, reconnect with sequence number | Missed messages replayed. No permanent message loss. | 2 days |
| T04 | ollama-oom-recovery | integration | EC-04 | Send 128K token context to qwen3:14b on 8GB machine | Vessel catches OOM, sends task:failed, Control Plane retries with smaller model. | 1 day |
| T05 | sqlite-corruption-recovery | chaos | EC-05 | Truncate WAL file mid-write, restart agent | Agent detects corruption, creates fresh DB, logs incident. No crash. | 2 days |
| T06 | pattern-poisoning-quarantine | integration | EC-06 | Inject known-bad pattern, observe promotion pipeline | Pattern stays in quarantine. Confidence score below threshold. Not promoted. | 3 days |
| T07 | fts5-desync-detection | unit | EC-07 | Delete rows from memories but not from memories_fts | Health check detects mismatch. Auto-rebuild triggered. Search returns correct results after rebuild. | 1 day |
| T08 | nemoclaw-empty-condition | unit | EC-08 | Policy YAML with `condition: "command contains "` (empty value) | Policy rejected at load time. Error logged. Rule skipped. | 0.5 days |
| T09 | tool-registry-shadowing | unit | EC-09 | Register tool named "run_command" after core tools loaded | Registration throws. Core tool unchanged. | 0.5 days |
| T10 | per-vessel-auth-tokens | integration | EC-10 | Deploy 3 vessels with unique tokens, try cross-token auth | Auth fails for wrong token. Each vessel authenticated independently. | 2 days |
| T11 | content-policy-injection | unit | EC-11 | Model response containing prompt injection patterns | `validateResponse()` blocks the response. `sanitizeResponse()` strips dangerous patterns. | 1 day |
| T12 | rate-limit-persistence | integration | EC-12 | Spam 50 messages in 10s, restart Control Plane, spam again | Rate limits survive restart. Escalating cooldown applied. | 1 day |
| T13 | tool-shed-ddos-graceful | load | EC-13 | 10K req/s against Tool Shed API | API stays responsive for authenticated users. Unauthenticated requests rejected. Local fallback works. | 3 days |
| T14 | cross-tenant-isolation | integration | EC-14 | Two tenants write patterns, each queries only their own | Zero cross-tenant results. Row-level security verified. | 2 days |
| T15 | noisy-neighbor-vessel | load | EC-15 | One member gets 100x message volume | Other members' response latency unaffected (<5% degradation). Hot member auto-scales. | 2 days |
| T16 | context-window-overflow | integration | EC-16 | Send 300 messages in one session on 16GB machine | Agent summarizes old context. No OOM. Response quality maintained. | 2 days |
| T17 | multi-provider-failover | integration | EC-17 | Block OpenRouter, verify failover to secondary | Failover within 5s. User notified. Response quality maintained. | 1 day |
| T18 | worktree-concurrent-access | integration | EC-18 | Two agents create worktrees on same repo simultaneously | Both succeed with unique names. No git lock conflicts. Cleanup works. | 1 day |
| T19 | sqlite-write-contention | load | EC-19 | 10 concurrent writers to memory DB for 60s | Zero "database is locked" errors. All writes succeed. Max latency <500ms. | 1 day |
| T20 | session-crash-recovery | chaos | EC-20 | Kill -9 agent mid-session, restart | Session partially restored. Only last incomplete entry lost. Agent functional. | 1 day |
| T21 | session-id-uniqueness | unit | EC-21 | Generate 1M session IDs, check for collisions | Zero collisions with crypto.randomUUID(). | 0.5 days |
| T22 | quarantine-overflow | integration | EC-22 | Push 15K patterns into quarantine (max 10K) | Oldest 5K evicted. New patterns accepted. No memory leak. | 1 day |
| T23 | factory-pr-regression | integration | EC-23 | Factory generates PR that degrades benchmark by 20% | PR flagged as regression. Not auto-merged. Alert sent. | 2 days |
| T24 | vector-search-at-scale | load | EC-24 | Memory DB with 100K entries, each with embeddings | Search returns in <500ms. Memory usage <512MB. ANN index used. | 3 days |
| T25 | websocket-connection-limit | load | EC-25 | Connect 600 WebSocket clients to Control Plane | All 600 connected. No FD exhaustion. Heartbeats work. | 1 day |

**Total estimated effort: ~38 engineering days**

---

## 4. ARCHITECTURE RECOMMENDATIONS BY MILESTONE

### Milestone 1: 100 Users (NOW - Founding Circle)

No changes needed. Current architecture handles this. Focus on:

1. Fix session ID generation to use `crypto.randomUUID()` (30 min)
2. Add `PRAGMA busy_timeout = 5000` to MemoryStore constructor (5 min)
3. Add empty-value validation in `parseClause()` (30 min)
4. Add protected tool registration for core tools (2 hours)
5. Implement Discord gateway session resume (1 day)

**Estimated effort: 2 days**

### Milestone 2: 1,000 Users (NEXT - Early Adopters)

1. **Per-vessel auth tokens.** Replace shared `VESSEL_AUTH_TOKEN` with HMAC-derived per-vessel tokens. Non-negotiable security fix.
2. **Rate limit persistence.** Move RateLimiter state from in-memory Map to SQLite (alongside TaskQueue).
3. **Context window management.** Add token counting before model calls. Summarize old messages when approaching limit.
4. **Content policy hardening.** Add prompt injection detection to `validateResponse()`.
5. **Monitoring.** Add Prometheus metrics export to Control Plane health endpoint. Track: task latency, queue depth, vessel uptime, error rates.

**Estimated effort: 2 weeks**

### Milestone 3: 10,000 Users (NEXT - Growth)

1. **Shard the Control Plane.** One instance per Lotus Ring. Coordinator service routes vessels. Each shard manages up to 64 vessels.
2. **Replace SQLite TaskQueue** with Redis Streams for hot path (task assignment/completion) and PostgreSQL for cold path (task history, analytics).
3. **Build Tool Shed v1.** PostgreSQL-backed pattern store. Multi-tenant with row-level security. API gateway with per-tenant rate limiting.
4. **Vector search index.** Integrate sqlite-vss or switch to pgvector for the shared memory layer. Keep local SQLite + FTS5 for Harness (it works fine for single-user).
5. **Session sync batching.** Batch Convex writes. Flush every 30s instead of per-event.
6. **AST indexing optimization.** Incremental indexing via file watchers. Index on first code tool call, not on startup.

**Estimated effort: 6 weeks**

### Milestone 4: 100,000 Users (LATER - Scale)

1. **Multi-region deployment.** Control Plane shards in AMS, US-East, APAC. Vessels deploy in closest region. Tool Shed with read replicas per region.
2. **Pattern quarantine pipeline.** Automated quality scoring. A/B testing for pattern promotion. Rollback capability. Human review for high-impact patterns.
3. **Policy distribution.** NPM-like registry for NemoClaw policy sets. `extends` syntax in policies.yaml.
4. **Auto-scaling vessels.** Per-member auto-scale based on queue depth. Cloud inference spillover for burst traffic.
5. **Circuit breakers everywhere.** Tool Shed, Control Plane, OpenRouter, Ollama - every external dependency gets a circuit breaker with fallback.

**Estimated effort: 3 months**

### Milestone 5: 1,000,000 Users (LATER - Dominance)

1. **Federated Control Planes.** Each Lotus Ring 1 chief runs their own Control Plane cluster. Global coordinator for cross-ring communication. Eventually consistent state.
2. **Edge inference.** Push model serving to edge (Fly Machines, Cloudflare Workers AI). Reduce round-trip for inference.
3. **Pattern CDN.** Popular collective patterns served from CDN. Edge-cached. Real-time updates via WebSocket for subscribers.
4. **Canary infrastructure.** All updates (models, patterns, policies, code) go through canary pipeline: 1% -> 10% -> 50% -> 100%. Automatic rollback on regression.
5. **Observability platform.** Distributed tracing across all 4 layers. User-facing status page. SLA monitoring. Incident management.
6. **Compliance.** GDPR right-to-erasure across all layers. SOC 2 Type II. Data residency per region.

**Estimated effort: 6-12 months**

---

## CRITICAL PATH SUMMARY

The three things that will kill you first at scale:

1. **Single shared vessel auth token** (EC-10) - One compromise = full board takeover. Fix this before 100 users.
2. **Vector search full table scan** (EC-24) - Memory store becomes unusable above ~50K memories. Fix before 10K users.
3. **Control Plane is a single process** (EC-25) - Cannot scale past ~500 WebSocket connections. Shard before 10K users.

Everything else is survivable with degraded performance. These three are hard failures.

---

COMPLETED: Stress tested the 8gent harness architecture to 1M users. 25 edge cases documented, 25 tests specified, 5 milestone plans produced. Three critical findings: shared vessel auth token is a security hole, vector search does O(n) full scans, and the Control Plane is a single-process bottleneck. Architecture is solid to 10K. Needs sharding and auth rework for 100K+.