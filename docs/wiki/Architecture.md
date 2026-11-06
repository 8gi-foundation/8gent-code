# Architecture

8gent Code is a Bun and TypeScript monorepo. `apps/` holds things you launch, `packages/` holds libraries and services they share. This page maps the main path a request takes and where each part lives. For drawn views see the repo's [architecture diagrams](../architecture/README.md) (system map, external services, outputs, known gaps).

## The main path

```
  8gent (bin/8gent.ts)
     |  resolves the TUI entry: embedded build, tui.js next to it,
     |  or apps/tui/src/index.tsx from a git checkout
     v
  apps/tui  (Ink terminal UI: tabs, slash commands, approval cards)
     |
     v
  packages/eight  (the loop: agent.ts, tools.ts, prompts/, modes.ts,
     |             session-store.ts, instruction-loader.ts)
     |
     +--> packages/providers  (registry, failover, routing) --> model
     |
     +--> tool calls --> packages/permissions (check first) --> packages/tools
     |
     +--> packages/memory (SQLite + FTS5)     ~/.8gent/sessions (sessions)
```

- **`bin/8gent.ts`** is the CLI entry. It handles subcommands (for example `daemon`, `run`, `mcp`) and otherwise starts the TUI. Headless runs go through `packages/eight/run.ts` instead of the TUI.
- **`apps/tui`** is the Ink v6 terminal UI. It imports the loop, session manager, providers and permissions from `packages/`.
- **`packages/eight`** is the core engine: the assistant loop (`agent.ts`), tool definitions (`tools.ts`, `tool-registry.ts`), system prompt (`prompts/`), working modes (`modes.ts`, optional custom modes from `~/.8gent/modes.yaml`), session persistence (`session-store.ts`, under `~/.8gent/sessions`) and project instruction loading (`instruction-loader.ts`). Model clients live in `packages/eight/clients/`.
- **`packages/providers`** holds the provider registry (`index.ts`), failover chains (`failover.ts`, chains stored in `~/.8gent/failover.json`), key resolution and routing policy. See [Providers and Models](Providers-and-Models).
- **`packages/permissions`** decides whether a tool call or shell command may run: policy engine, always-blocked list, path guards, the four permission modes (`permission-mode.ts`). See [Permission Modes](Permission-Modes).
- **`packages/tools`** implements the tools themselves (shell, files, browser fetch, speech and more).
- **`packages/memory`** is the SQLite store (`bun:sqlite`, FTS5, optional vector search) with memory types, consolidation and auto-injection.

## Other long-lived pieces

- **Daemon** (`packages/daemon`): an always-on process with a WebSocket gateway, event bus, cron scheduler and an `AgentPool` that creates one assistant per session (`agent-pool.ts`). Sessions carry a `channel` such as `os`, `telegram`, `discord`, `api` or `computer` (`gateway.ts`). Started with `8gent daemon`.
- **Orchestration** (`packages/orchestration`): delegation to child assistants, `WorktreePool` (default maximum of 4 concurrent git worktrees, `worktree-pool.ts`) and `WorktreeManager` for isolated sandboxes, pipelines and filesystem messaging between workers.
- **Goal loop** (`packages/goal`): executor, judge, budget and receipt for the `/goal` feature; pure logic, with I/O left to the daemon.
- **Channels** (`packages/channels`): a messaging abstraction for Telegram, Discord, Slack and WhatsApp.

## Extension points

- **Hooks** (`packages/hooks`): lifecycle hooks (`beforeTool`, `afterTool`, `onError`, `onComplete`, `beforeCommand`, `afterCommand`, `onStart`, `onExit`) loaded from `~/.8gent/hooks.yaml` or `hooks.json`.
- **MCP** (`packages/mcp`): a client that connects to MCP servers listed in `~/.8gent/mcp.json` and exposes their tools, plus a server (`server.ts`) started by the `mcp` subcommand.
- **Skills** (`packages/skills`): markdown workflows loaded from `~/.8gent/skills/`, project overrides, bundled `packages/skills/<name>/SKILL.md`, and `~/.8gent/learned-skills/`. See `packages/skills/README.md`.
- **Extensions** (`packages/extensions`): loader and host for extensions kept in `~/.8gent/extensions/`, which can contribute tools.
- **Quarantine and toolshed** (`packages/quarantine`, `packages/toolshed`): imported third-party skills are cloned, scanned and abstracted in quarantine before the toolshed registers them.

## Key packages

| Package | What it does |
|---|---|
| `eight` | Assistant loop, tools, prompts, modes, sessions, headless `run` |
| `ai` | AI SDK integration, task routing, tool loop used by daemon-side runners |
| `providers` | Provider registry, failover chains, routing policy, usage monitor |
| `permissions` | Policy engine, permission modes, always-blocked commands, sandbox helpers |
| `tools` | Tool implementations the loop calls |
| `memory` | SQLite and FTS5 memory store, consolidation, auto-injection |
| `daemon` | Always-on gateway, `AgentPool`, event bus, service install |
| `orchestration` | Child assistants, worktree pool and manager, pipelines |
| `goal` | Goal-loop orchestrator (executor, judge, budget, receipt) |
| `hooks` | User lifecycle hooks |
| `mcp` | MCP client and server |
| `skills` | Bundled and user skills, skill manager |
| `extensions` | Extension loader and host |
| `settings` | Typed settings store persisted to `~/.8gent/settings.json` |
| `secrets` | Encrypted key vault tied to the machine (AES-256-GCM), keychain and libsecret backends |
| `core` | Small shared helpers (home paths, shell, path checks) |
| `kernel` | RL fine-tuning pipeline, off by default |
| `self-autonomy` | Reflection, learned skills, improvement loop |
| `validation` | Checkpoint, failure log, security scanner |
| `verify` | Deterministic verification of claims against references |
| `ast-index` | Symbol-level code index; also runs the import-rule check below |
| `harness`, `harness-cli` | Pluggable harness abstraction; headless CLI for running and inspecting sessions |
| `channels`, `telegram-bot`, `telegram` | Messaging surfaces |
| `board-vessel`, `control-plane`, `board-plane` | Multi-vessel runtime and orchestration |
| `quarantine`, `toolshed` | Safe import of external skills |
| `durable-run` | Durable run ledger and storage |
| `cron` | Routines and scheduled jobs |
| `db` | Convex database layer (accounts, usage, preference sync) |

Other packages, listed by name: `8dk`, `app-creator`, `audit`, `auth`, `ci`, `computer`, `decide`, `deck`, `design-agent`, `design-compose`, `design-systems`, `dreams`, `executor`, `eyes`, `film-craft`, `flow`, `g8way`, `gamedev`, `hands`, `handeyes`, `i18n`, `infinite`, `install-runner`, `local-model-server`, `lsp`, `marketplace`, `music`, `node-compat`, `personality`, `pet`, `planner`, `planning`, `prepared`, `proactive`, `qdrant-client`, `registry`, `render`, `repo-context`, `reporting`, `runtime`, `schema`, `specifications`, `table`, `tasks`, `telemetry`, `terminal-tab`, `threat-feed`, `travel`, `types`, `voice`, `workflow`. Read each package's entry file for its purpose.

## Apps

| App | What it is |
|---|---|
| `apps/tui` | The terminal UI, the main product surface |
| `apps/debugger` | Session inspector |
| `apps/proxy` | OpenAI-compatible localhost gateway over the adaptive router |
| `apps/8gent-eyes` | Headless CLI for screen perception (capture, find, describe, wait) |
| `apps/8gent-flow` | Mac vision relay for flow clients |
| `apps/8gent-bot`, `apps/linkedin-vessel` | Telegram orchestrator and an outreach vessel |
| `apps/8gent-computer`, `apps/lil-eight` | Swift macOS apps |
| `apps/convex`, `apps/video` | Convex backend functions; Remotion video compositions |

## Import rules

`architecture.rules.json` at the repo root lists forbidden package imports and the import-cycle groups that already existed. Currently `permissions`, `secrets` and `quarantine` must not import `eight` directly. The check is `bun packages/ast-index/arch-rules.ts`. Many core packages sit in one large cycle group, so do not assume strict layering; the file says new edges inside the group are not caught.
