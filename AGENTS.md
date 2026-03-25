# AGENTS.md

Universal agent instructions for any AI coding harness working on this repo.
Works with: Claude Code, Pi, Hermes, OpenCode, Aider, Goose, Cline, Continue, SWE-Agent, or any future agent.

---

## What is this project?

8gent Code is an open source autonomous coding agent TUI - a personal AI operating system kernel that runs locally via Ollama or free cloud models via OpenRouter.

- **Language:** TypeScript
- **Runtime:** Bun (not Node)
- **Package manager:** Bun (`bun install`, not `npm install`)
- **TUI framework:** Ink v6 (React for CLI)
- **Monorepo structure:** `apps/` + `packages/`
- **License:** MIT

## Quick start

```bash
bun install          # install dependencies
bun run tui          # launch the TUI
bun run benchmark:v2 # run a benchmark pass
```

## Repository structure

```
apps/
  tui/              # Main terminal UI (Ink/React)
  clui/             # Desktop overlay (Tauri 2.0)
  lil-eight/        # macOS dock pet (Swift)
  dashboard/        # Web dashboard
  debugger/         # Debug tools
  demos/            # Example demos
  installer/        # Install wizard

packages/
  eight/            # Core agent loop, tools, system prompt
  providers/        # LLM provider abstraction (Ollama, OpenRouter)
  memory/           # SQLite + FTS5 dual-layer memory
  permissions/      # NemoClaw YAML policy engine
  self-autonomy/    # Evolution, reflection, HyperAgent
  orchestration/    # Worktree pool, parallel agents
  validation/       # Checkpoint-verify-revert loop
  computer/         # Desktop automation (screenshot, click, type, process management)
  tools/            # Browser, web, actuators, utilities
  music/            # DJ, radio, synth, MusicGen
  pet/              # Companion system (terminal + dock)
  daemon/           # Persistent vessel daemon (Fly.io)
  kernel/           # RL fine-tuning pipeline (GRPO)
  ast-index/        # Import graph, change impact estimation
  proactive/        # GitHub bounty scanner, opportunity pipeline
  mcp/              # Model Context Protocol client
  lsp/              # Language Server Protocol integration
  hooks/            # Pre/post tool hooks
  personality/      # Brand voice, persona
  ai/               # Vercel AI SDK integration
  telegram/         # Telegram bot
  voice/            # Voice input/output
  ...
```

## Key files an agent should know

| File | Purpose |
|------|---------|
| `packages/eight/tools.ts` | All tool definitions and execution - the bridge between LLM and system |
| `packages/eight/agent.ts` | Agent loop, abort, checkpoint restore |
| `packages/eight/prompts/system-prompt.ts` | System prompt with user context injection |
| `packages/permissions/policy-engine.ts` | NemoClaw policy engine (YAML-based, deny-by-default) |
| `packages/permissions/default-policies.yaml` | Default safety policies |
| `packages/memory/store.ts` | Memory store (SQLite + FTS5) |
| `packages/computer/index.ts` | Desktop automation API |
| `packages/computer/process-manager.ts` | Process listing and quit (Quitty-inspired) |
| `BRAND.md` | Design system, colors, typography rules |
| `CHANGELOG.md` | Release history |

## Rules for contributing agents

### Non-negotiable

1. **No em dashes.** Use hyphens (-) or rewrite. No exceptions.
2. **No purple/pink/violet colors.** Hues 270-350 are banned. See BRAND.md.
3. **No stat padding.** Only state what actually exists with evidence.
4. **No enthusiasm inflation.** State what was done, what works, what doesn't.
5. **Bun, not Node.** Use `bun` for all commands. `bun install`, `bun run`, `bun test`.
6. **Test before pushing.** Run the TUI (`bun run tui`) before any push. Never push untested code.

### Code style

- TypeScript strict mode
- No default exports (use named exports)
- Errors as values, not exceptions (return `{ ok, error }` patterns)
- Path validation via `safePath()` for any user-provided file paths
- Shell command validation via `sanitizeShellCommand()` for any executed commands
- Rate limiting on tool calls to prevent LLM loops

### Architecture principles

- **Local-first.** No API keys required to start. Ollama default.
- **Deny-by-default.** All destructive operations go through the NemoClaw policy engine.
- **Import concepts, not code.** Study external projects, extract patterns, rebuild in <200 lines.
- **Smallest thing that works.** Not the most impressive - the smallest that ships.
- **One kernel, many interfaces.** The Eight kernel powers TUI, CLUI, daemon, voice, and more.

### TUI color rules

Never use raw colors in the TUI. Use semantic tokens only:

| Purpose | Use |
|---------|-----|
| Muted text | `dimColor` prop |
| Emphasis | `bold` prop |
| Brand/assistant | `color="cyan"` |
| User text | `color="yellow"` |
| Success | `color="green"` |
| Error | `color="red"` |
| Borders | `color="blue"` or `color="cyan"` |

Never use `color="gray"`, `color="white"`, or `color="black"` - they break on various terminal themes.

### AI judging

Never use string matching (regex, `.includes()`) to evaluate agent output. Always use a model as a judge via the Vercel AI SDK (`ai` package).

### Memory system

Dual-layer episodic + semantic memory in SQLite with FTS5:
- Episodic: timestamped facts, auto-decayed over 30 days
- Semantic: consolidated, promoted facts with frequency scoring
- Natural language queries supported
- Relevant memories auto-injected into system prompt

### Policy engine

The NemoClaw policy engine evaluates every tool call:
- Policies defined in YAML at `packages/permissions/default-policies.yaml`
- User overrides at `~/.8gent/policies.yaml`
- Three decisions: `allow`, `require_approval`, `block`
- Desktop automation requires approval for mutations, allows reads

### Versioning

- Source of truth: `package.json` version field
- Also sync: `bin/8gent.ts` VERSION constant, README badge
- SemVer strictly: PATCH for fixes, MINOR for features, MAJOR for breaking changes
- CHANGELOG.md is mandatory for every significant change

## What makes this repo different

This is not just a coding agent. It is a personal AI operating system kernel with:

- **10 ability packages** (Memory, DJ, Worktrees, Policy, Evolution, Healing, Entrepreneurship, AST, Browser, Desktop)
- **Companion pet system** - Lil Eight lives on your macOS dock, reacts to agent state, collectible cards
- **Self-improvement** - HyperAgent meta-mutation, autoresearch loop, personal LoRA fine-tuning
- **Persistent daemon** - runs 24/7 on Fly.io Amsterdam
- **6-product ecosystem** - OS, Code, App, World, Games, Jr
- **Constitution-governed** - https://8gent.world/constitution

## External references

| Resource | URL |
|----------|-----|
| Website | https://8gent.dev |
| World / Docs | https://8gent.world |
| Constitution | https://8gent.world/constitution |
| npm package | @podjamz/8gent-code |
| Daemon | https://eight-vessel.fly.dev |
| Competitive analysis | https://8gent.world/media/decks/competitive-analysis |

## For humans

PRs welcome. The bottleneck is human testers. The self-improvement flywheel spins faster with every contributor. File issues, send PRs, break things, make it better.

```bash
npm install -g @podjamz/8gent-code
8gent
```
