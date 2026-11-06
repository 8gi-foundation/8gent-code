# Glossary

Terms you meet when using or working on 8gent Code. See [Architecture](Architecture) for where each lives.

**Permission mode** - How much 8gent may do without asking. Four modes from least to most permissive: `plan` (read-only), `ask` (default, approval card for unlisted commands), `guarded` (System One screens every shell command first) and `infinite` (everything except the always-blocked list runs; expires after 30 minutes). Shift+Tab cycles them. See [Permission Modes](Permission-Modes).

**Always-blocked list** - Commands refused in every mode, including `infinite` (`packages/permissions/always-blocked.ts`).

**System One** - The gate in `packages/permissions` that checks shell commands against a read-only allowlist and can allow, block or escalate to an approval card.

**Approval card** - The prompt shown in the TUI when a command needs your yes before it runs.

**Provider** - A model backend in the registry (`packages/providers/index.ts`), for example `8gent`, `ollama`, `lmstudio`, `openrouter`, `anthropic`. Local ones need no key; hosted ones are opt-in via a key. See [Providers and Models](Providers-and-Models).

**Failover** - Moving to the next healthy model in a chain when the current one is down. Chains are stored in `~/.8gent/failover.json` (`packages/providers/failover.ts`).

**Routing policy** - Rules for where a request may go, such as local only. See `docs/ROUTING-POLICY.md` in the repo.

**Mode (working mode)** - A named preset for the assistant, built in or defined in `~/.8gent/modes.yaml` (`packages/eight/modes.ts`). Not the same as a permission mode.

**Slash command** - A message starting with `/` typed in the TUI. Skills can be invoked explicitly as `/skill:<name>`. See [Commands](Commands).

**Skill** - A markdown-authored, reusable workflow loaded by the skill manager from `~/.8gent/skills/`, project overrides, bundled `packages/skills/`, and `~/.8gent/learned-skills/`.

**Learned skill** - A skill promoted by the skill compounder, stored in `~/.8gent/learned-skills/`.

**Hook** - A user command run at a lifecycle point: `beforeTool`, `afterTool`, `onError`, `onComplete`, `beforeCommand`, `afterCommand`, `onStart`, `onExit`. Configured in `~/.8gent/hooks.yaml` or `hooks.json`.

**MCP (Model Context Protocol)** - A protocol for plugging external tool servers in. Servers are listed in `~/.8gent/mcp.json`; 8gent can also run as an MCP server.

**Extension** - A plugin loaded from `~/.8gent/extensions/` that can add tools (`packages/extensions`).

**Quarantine** - The staging step where an external skill is cloned, scanned and abstracted before it is registered in the toolshed.

**Memory (episodic, semantic, procedural, core, working)** - The memory types in `packages/memory/types.ts`. Episodic memories are timestamped facts from conversations that decay over time; semantic memories are consolidated facts promoted from them; procedural memories hold learned workflows. Stored in SQLite with FTS5 search.

**Consolidation** - The background process that merges and promotes memories (`packages/memory/consolidation.ts`).

**Session** - One conversation with its history, persisted under `~/.8gent/sessions` so it can be resumed. In the daemon, each session also has a `channel`.

**Tab** - A parallel conversation in the TUI, each with its own permission mode.

**Daemon** - The always-on process (`packages/daemon`) with a WebSocket gateway, scheduler and a pool of per-session assistants. Start it with `8gent daemon`.

**Channel** - The surface a daemon session comes from, such as `os`, `telegram`, `discord`, `api` or `computer`.

**Vessel** - A long-running 8gent process with its own identity, such as the daemon or a runtime in `packages/board-vessel`.

**Worktree** - A separate git checkout of the same repo. `WorktreePool` and `WorktreeManager` in `packages/orchestration` give each child assistant its own so edits do not collide.

**Child assistant (sub-assistant)** - An assistant spawned by another to do part of a task, with its permission mode clamped to no more than its parent's.

**Goal loop (`/goal`)** - A run with an executor, a judge, a budget and a receipt that repeats until the judge accepts or the budget ends (`packages/goal`).

**Headless run** - Running 8gent without the TUI, through `packages/eight/run.ts` or the harness CLI.

**Harness** - A pluggable backend interface that lets 8gent run work through its own loop or another tool (`packages/harness/SPEC.md`).

**Durable run** - A run recorded in a ledger on disk (`packages/durable-run`).

**Principles gate** - The CI check `bun scripts/local-first-gate.ts` that fails if a default path sends data off the device or runs an install. See `docs/security/principles-gate.md`.

**Architecture rules** - `architecture.rules.json`, the forbidden package imports and baseline import cycles checked in CI.
