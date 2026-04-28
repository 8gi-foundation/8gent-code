<p align="center">
  <img src=".github/assets/readme-header.png" width="100%" alt="8gent Code" />
</p>

<p align="center">
  <strong>The kernel of the <a href="https://8gent.world">8gent ecosystem</a>.</strong><br />
  Open source autonomous coding agent powered by local LLMs or free cloud models.<br />
  No API keys. No usage caps. No cloud dependency.
</p>

<br />

<p align="center">
  <a href="https://8gentjr.com"><img src="https://img.shields.io/badge/Jr-Live-2D8A56?style=for-the-badge&labelColor=1A1612" alt="Jr Live" /></a>
  <a href="https://github.com/8gi-foundation/8gent-code"><img src="https://img.shields.io/badge/Code-Open_Source-2D8A56?style=for-the-badge&labelColor=1A1612" alt="Code Open Source" /></a>
  <a href="https://8gentos.com"><img src="https://img.shields.io/badge/OS-In_Dev-E8610A?style=for-the-badge&labelColor=1A1612" alt="OS In Dev" /></a>
  <a href="https://8gent.world"><img src="https://img.shields.io/badge/World-In_Dev-E8610A?style=for-the-badge&labelColor=1A1612" alt="World In Dev" /></a>
  <a href="https://8gent.games"><img src="https://img.shields.io/badge/Games-In_Dev-E8610A?style=for-the-badge&labelColor=1A1612" alt="Games In Dev" /></a>
</p>

<p align="center">
  <a href="https://www.apache.org/licenses/LICENSE-2.0"><img src="https://img.shields.io/badge/License-Apache_2.0-E8610A?style=for-the-badge&labelColor=1A1612" alt="Apache 2.0 License" /></a>
  <a href="https://8gent.dev"><img src="https://img.shields.io/badge/version-0.12.1-2D8A56?style=for-the-badge&labelColor=1A1612" alt="v0.12.1" /></a>
  <a href="https://eight-vessel.fly.dev"><img src="https://img.shields.io/badge/daemon-Fly.io_Amsterdam-E8610A?style=for-the-badge&labelColor=1A1612" alt="Daemon" /></a>
</p>

<br />

---

<br />

## The Ecosystem

<p align="center"><sub>2 shipped &nbsp;·&nbsp; 5 in development &nbsp;·&nbsp; 1 constitution</sub></p>

<br />

<table>
<tr>
<td valign="top" width="33%">

**8gent Code** -[8gent.dev](https://8gent.dev)<br />
<sub>Open source developer agent. Free on-ramp. Shipped. <em>(this repo)</em></sub>

**8gent Jr** -[8gentjr.com](https://8gentjr.com)<br />
<sub>AI assistant for kids. Accessibility first. Free forever. Shipped.</sub>

</td>
<td valign="top" width="33%">

**8gent OS** -[8gentos.com](https://8gentos.com)<br />
<sub>Paid personal OS. In development.</sub>

**8gent** -[8gent.app](https://8gent.app)<br />
<sub>Single pane of glass dashboard. In development.</sub>

</td>
<td valign="top" width="33%">

**8gent World** -[8gent.world](https://8gent.world)<br />
<sub>Ecosystem story, docs, <a href="https://8gent.world/media/decks">presentation decks</a>. In development.</sub>

**8gent Games** -[8gent.games](https://8gent.games)<br />
<sub>Agent simulation playground. In development.</sub>

</td>
</tr>
</table>

<p align="center">
  <sub><a href="https://8gent.world/constitution">Constitution</a> &nbsp;·&nbsp; <a href="https://8gent.world/inspirations">Inspirations</a></sub>
</p>

<br />

---

<br />

## 8GI Foundation

8gent Code is the technology layer of the **8GI Foundation** - the autonomous collective intelligence that governs the 8gent ecosystem. 8GI is not a company. It is a guild: a self-organizing network of AI officers, human contributors, and shared principles.

Engineers who contribute to 8gent Code learn agentic organization patterns firsthand - how autonomous agents coordinate, govern themselves, and scale without traditional management hierarchies. See the [Guild Deck](https://8gent.world/media/decks) for the full vision.

All governance docs, decks, and the constitution live at [8gent.world](https://8gent.world). Source-of-truth markdown for governance (including security and onboarding) is in the [`8gi-governance`](https://github.com/8gi-foundation/8gi-governance) repository; static deck assets ship with [`8gent-world`](https://github.com/8gi-foundation/8gent-world) under `public/media/`.

### The Board - 8 Seats of the Inner Circle

The 8GI board consists of AI officers, not humans. James Spalding serves as Founder and Visionary.

| Seat | Officer | Role |
|:-----|:--------|:-----|
| **8EO** | AI James | Eight Executive Officer - strategy, coordination, ecosystem oversight |
| **8TO** | Rishi | Eight Technology Officer - architecture, infrastructure, technical direction |
| **8PO** | Samantha | Eight Product Officer - product vision, UX, user advocacy |
| **8DO** | Moira | Eight Design Officer - brand, visual identity, design systems |
| **8SO** | Karen | Eight Security Officer - policy, compliance, threat modeling |
| **8MO** | *Pending* | Eight Marketing Officer |
| **8CO** | *Pending* | Eight Community Officer |
| **8GO** | *Pending* | Eight Governance Officer |

### The Lotus Model

8GI scales through the Lotus structure: **1-8-64-512**. One founder. Eight AI officers (the inner circle). 64 working vessels (specialized agents). 512 edge nodes (community contributors and autonomous tasks). Each layer multiplies capacity without multiplying complexity.

### Constitution

The [10 Articles of the 8gent Constitution](https://8gent.world/constitution) govern all decisions across every product and every agent in the ecosystem.

### Control Plane Architecture

The autonomous vessel infrastructure lives in two packages:

- `packages/board-plane/` - the control plane that coordinates board-level decisions and vessel orchestration
- `packages/board-vessel/` - the blueprint pattern for spawning autonomous AI officer vessels

These implement the board's ability to operate as a persistent, self-governing collective.

### GitHub and Community

All code lives under [github.com/8gi-foundation](https://github.com/8gi-foundation).

| Repo | Role |
|------|------|
| **[8gent](https://github.com/8gi-foundation/8gent)** (8gent.app) | The front door. Dashboard. Auth. Billing. User management. |
| **[8gi-control-plane](https://github.com/8gi-foundation/8gi-control-plane)** | The brain. Model routing. Rate limiting. Token tracking. |
| **[8gent-vessel](https://github.com/8gi-foundation/8gent-vessel)** | The body. Compute. Sandboxes. Storage. Health. |
| **[8gent-code](https://github.com/8gi-foundation/8gent-code)** | The kernel. What runs inside every vessel. *(this repo)* |
| **[8gent-OS](https://github.com/8gi-foundation/8gent-OS)** | The personal layer on top of the kernel. |
| **[8gi-governance](https://github.com/8gi-foundation/8gi-governance)** | The constitution. Board decisions. Member registry. |
| **[8gent-world](https://github.com/8gi-foundation/8gent-world)** | Ecosystem story, docs, media. |
| **[8gent-dev](https://github.com/8gi-foundation/8gent-dev)** | Developer portal. |
| **[8gent-games](https://github.com/8gi-foundation/8gent-games)** | Agent simulation playground. |
| **[8gent-telegram-app](https://github.com/8gi-foundation/8gent-telegram-app)** | Jr Telegram interface. |

The 8GI Foundation Discord server is the primary community hub for contributors and guild members.

<br />

---

<br />

## Quick Start

```bash
npm install -g @8gi-foundation/8gent-code
8gent
```

That's it. 8gent uses an adaptive 11-provider router. Default active provider is `8gent` local (model `eight-1.0-q3:14b`) with `ollama` also enabled by default. Cloud providers (OpenRouter, Groq, OpenAI, Anthropic, Mistral, Together, Fireworks, Replicate, Grok) are opt-in via API key. Failover chain: local 8gent, then local Qwen, then OpenRouter free tier.

## Quick Start (from source)

```bash
git clone https://github.com/8gi-foundation/8gent-code.git
cd 8gent-code
bun install
bun run tui
```

If no local model is available, 8gent will guide you through interactive onboarding on first run. The adaptive provider router tries local 8gent, then Ollama, then OpenRouter free tier.

<br />

---

<br />

## Why 8gent exists

Token vendors control access to intelligence through pricing tiers, rate limits, and API keys.
That is a business model, not a law of nature. It is also not the only option.

8gent runs locally, privately, and for free. No credit card. No usage cap. No cloud dependency required.

Every policy that governs what the agent can do is a YAML file you can read, edit, and override.
Every memory the agent stores is a SQLite database on your own disk. Nothing phones home.

Self-improvement: the autoresearch loop runs benchmarks, mutates the system prompt, and promotes what works. This runs locally.
Your agent runs locally. Your data never leaves your machine. Every policy is readable YAML.
No central vendor captures that value.

The floor is zero cost. The ceiling is what a self-improving local agent can learn from your codebase.

Try it: `npm install -g @8gi-foundation/8gent-code && 8gent`

### From source (contributors)

```bash
git clone https://github.com/8gi-foundation/8gent-code.git && cd 8gent-code && bun install
bun run tui
```

<br />

---

<br />

## What Makes This Different

<table>
<tr>
<td valign="top" width="50%">

**Local-first, free by default**<br />
<sub>Runs entirely on your machine. Cloud models (OpenRouter free tier) are opt-in. No telemetry, no API keys to start.</sub>

<br />

**Model-agnostic**<br />
<sub>Adaptive 11-provider router: 8gent local, Ollama, OpenRouter, Groq, OpenAI, Anthropic, Mistral, Together, Fireworks, Replicate, Grok. Everything except 8gent/ollama is opt-in via API key. Task router classifies prompts (code, reasoning, simple, creative) and picks the best model automatically.</sub>

<br />

**Eight kernel**<br />
<sub>Persistent daemon deployed on Fly.io Amsterdam (<a href="https://eight-vessel.fly.dev">eight-vessel.fly.dev</a>). WebSocket protocol, 4-strategy retry loop, session persistence across reconnections.</sub>

<br />

**NemoClaw policy engine**<br />
<sub>YAML-based, deny-by-default, rebuilt from scratch. 11 default rules with approval gates for secrets, destructive ops, network, git, and file access. Headless and infinite modes for autonomous operation.</sub>

</td>
<td valign="top" width="50%">

**8 Powers**<br />
<sub>Memory, parallel worktrees, NemoClaw policy, self-evolution, self-healing, entrepreneurship, AST blast radius, and browser access. Not plugins. Built-in.</sub>

<br />

**HyperAgent meta-improvement**<br />
<sub>Metacognitive self-modification. The agent can improve how it improves -meta-config is editable while the evaluation protocol stays human-controlled.</sub>

<br />

**AutoResearch**<br />
<sub>Overnight improvement loops (Karpathy-style). Runs benchmarks, mutates system prompts, re-tests. Meta-optimizer also tunes few-shots, model routing, and grading weights.</sub>

<br />

**Voice**<br />
<sub>macOS TTS voices (Moira, Daniel, Samantha, Karen, Rishi) with KittenTTS neural voices as optional upgrade. Full-duplex Moshi backend scaffolded for Apple Silicon. <code>/voice chat</code> to start.</sub>

<br />

**AST-first navigation** &nbsp;·&nbsp; **Multi-agent orchestration** &nbsp;·&nbsp; **Telegram portal**

</td>
</tr>
</table>

<br />

---

<br />

## The 8 Powers

<table>
<tr>
<td valign="top" width="25%">

**Memory**<br />
<sub><code>packages/memory/</code></sub><br />
<sub>Dual-layer episodic + semantic memory, SQLite + FTS5, Ollama embeddings, procedural memory, health monitoring, contradiction detection, consolidation, lease-based job queue</sub>

</td>
<td valign="top" width="25%">

**Worktree**<br />
<sub><code>packages/orchestration/</code></sub><br />
<sub>Multi-agent parallel execution via git worktrees, max 4 concurrent, filesystem messaging, macro-actions, delegation</sub>

</td>
<td valign="top" width="25%">

**Policy**<br />
<sub><code>packages/permissions/</code></sub><br />
<sub>NemoClaw YAML policy engine, 11 default rules, approval gates, headless mode, infinite mode, dangerous command detection</sub>

</td>
<td valign="top" width="25%">

**Evolution**<br />
<sub><code>packages/self-autonomy/</code></sub><br />
<sub>Post-session reflection, Bayesian skill confidence, HyperAgent meta-mutation, skill compounding (tasks become reusable skills), KittenTTS voice onboarding</sub>

</td>
</tr>
<tr>
<td valign="top" width="25%">

**Healing**<br />
<sub><code>packages/validation/</code></sub><br />
<sub>Checkpoint-verify-revert loop, git-stash atomic snapshots, failure log</sub>

</td>
<td valign="top" width="25%">

**Entrepreneurship**<br />
<sub><code>packages/proactive/</code></sub><br />
<sub>GitHub bounty/help-wanted scanner, capability matcher, opportunity pipeline</sub>

</td>
<td valign="top" width="25%">

**AST**<br />
<sub><code>packages/ast-index/</code></sub><br />
<sub>Blast radius engine, import dependency graph, test file mapping, change impact estimation</sub>

</td>
<td valign="top" width="25%">

**Browser**<br />
<sub><code>packages/tools/browser/</code></sub><br />
<sub>Lightweight web access via fetch + DuckDuckGo HTML scraping, disk cache, no headless deps</sub>

</td>
</tr>
</table>

<br />

---

<br />

## Companion System

Every session spawns a unique companion. Your coding history becomes a collectible deck.

- **40 species** across 5 rarity tiers (Common 60% to Legendary 1%)
- **10 elements** inspired by MTG color pie (Void, Ember, Aether, Verdant, Radiant, Chrome, Prism, Frost, Thunder, Shadow)
- **29 accessories** from Pokeball to Triforce to One Ring
- **6 stats** per companion (DEBUG, CHAOS, WISDOM, PATIENCE, SNARK, ARCANA)
- **1% shiny** chance
- **Collection deck** persists at `~/.8gent/companion-deck.json`
- **macOS dock pet** spawns with companion's name and colors

```bash
/pet start      # Spawn companion on dock
/pet deck       # View your collection
/pet card       # Roll a new card
```

See [packages/pet/README.md](packages/pet/README.md) for the full bestiary.

<br />

---

<br />

## Presentations

| Deck | Link |
|------|------|
| **Feature Set Audit** | [8gent.world/media/decks/feature-set](https://8gent.world/media/decks/feature-set) |
| **npm Launch** | [8gent.world/media/decks/npm-launch](https://8gent.world/media/decks/npm-launch) |
| **Lil Eight Pets** | [8gent.world/media/decks/lil-eight](https://8gent.world/media/decks/lil-eight) |
| **Companion System** | [8gent.world/media/decks/companion-system](https://8gent.world/media/decks/companion-system) |
| **Code Roadmap** | [8gent.world/media/decks/code-roadmap](https://8gent.world/media/decks/code-roadmap) |
| **All Decks** | [8gent.world/media/decks](https://8gent.world/media/decks) |

<br />

---

<br />

## Voice

**Half-duplex** (`/voice chat`) - listen, transcribe, think, speak, repeat. Requires sox and whisper.cpp:

```bash
brew install sox whisper-cpp
```

**TTS output** - macOS `say` voices (Moira, Daniel, Samantha, Karen, Rishi) work out of the box. KittenTTS neural voices (8 voices, free, local) are available as an optional upgrade - offered during onboarding.

**Full-duplex** (experimental) - simultaneous listen and speak via Moshi (Kyutai) on Apple Silicon. Backend code exists in `packages/voice/backends/moshi-mlx.ts` but requires manual setup (`pip install moshi`).

<sub>Status bar shows: <strong>VOICE CHAT (listening)</strong> / <strong>SPEAKING</strong> / <strong>THINKING</strong></sub>

<br />

---

<br />

## How It Works

```
User prompt
  -> BMAD planner (structured task decomposition)
  -> Multi-agent orchestration (sub-agents in worktrees)
  -> Toolshed (MCP, LSP, shell, AST, filesystem)
  -> Execution + validation (self-healing loop)
  -> Result
```

<sub>The agent decomposes work, delegates to sub-agents, validates output against test suites, and reports back. It uses the BMAD method for planning and AST-level symbol retrieval to keep token usage minimal.</sub>

<br />

---

<br />

## Benchmarks

<p align="center"><sub>Execution-graded tests across professional domains. Local inference via the adaptive router (8gent / Ollama defaults).<br />Code compiles and runs against <code>bun:test</code> suites, or it fails. No string matching, no vibes.</sub></p>

<br />

| ID | Domain | Task | Score |
|:---|:-------|:-----|------:|
| BT001 | Software Engineering | SaaS Auth: JWT, Roles, Rate Limiting | **94** |
| BT002 | Software Engineering | Event-Driven Architecture: Pub/Sub, DLQ, Retry | **92** |
| BT003 | Data Engineering | Stream Processing Pipeline | **100** |
| BT005 | Software Engineering | Typed State Machine: Guards, Actions | **92** |
| BT007 | Digital Marketing | SEO Audit Engine: Scoring, Core Web Vitals | **96** |
| BT011 | Video Production | Scene Graph, Timeline, FFmpeg CLI | **100** |
| BT012 | Music Technology | Notes, Chords, Scales, Progressions | **81** |
| BT014 | AI Consulting | Assessment Report Generator | **95** |

<sub>Additional categories: long-horizon (LH001–LH005), agentic (TC001–MR001), fullstack (FS001–FS003), UI design (UI001–UI008), ability showcase.</sub>

```bash
bun run benchmark:v2                    # single pass
CATEGORY=battle-test bun run benchmark:loop  # autoresearch loop
```

<sub>Full results: <a href="benchmarks/README.md">benchmarks/README.md</a> &nbsp;·&nbsp; Model shootout: <a href="docs/MODEL-SHOOTOUT.md">docs/MODEL-SHOOTOUT.md</a></sub>

<br />

---

<br />

## Project Structure

<table>
<tr>
<td valign="top" width="50%">

### Apps

```
apps/
  tui/           Ink v6 terminal UI (main interface, shipped)
  clui/          Tauri 2.0 desktop overlay (scaffolded)
  dashboard/     Next.js admin panel (scaffolded)
  debugger/      Session debugger (scaffolded)
  demos/         Remotion video generation
  installer/     Interactive install wizard (shipped)
```

</td>
<td valign="top" width="50%">

### Packages

```
packages/
  eight/         Core agent engine (Vercel AI SDK) - shipped
  providers/     11-provider adaptive router + failover - shipped
  memory/        SQLite + FTS5 persistent memory - shipped
  orchestration/ WorktreePool, role registry, macro actions - shipped
  permissions/   NemoClaw YAML policy engine - shipped
  self-autonomy/ Evolution, reflection, HyperAgent - shipped
  validation/    Self-healing executor - shipped
  proactive/     Business agents, opportunity scanner - shipped
  ast-index/     Blast radius engine - shipped
  tools/         75 tools: filesystem, shell, git, browser, AST - shipped
  voice/         STT (whisper.cpp) + TTS (macOS/KittenTTS) - partial
  kernel/        RL fine-tuning pipeline (off by default) - shipped
  personality/   Brand voice, "Infinite Gentleman" - shipped
  pet/           Companion system + dock pet - shipped
  telegram/      Telegram bot portal - shipped
  daemon/        Persistent vessel daemon (Fly.io) - partial
  auth/          Clerk auth + GitHub integration - scaffolded
  db/            Convex reactive database - scaffolded
  control-plane/ Multi-tenant management - scaffolded
  board-plane/   Board-level vessel orchestration - scaffolded
  board-vessel/  Autonomous AI officer blueprint - scaffolded
```

</td>
</tr>
</table>

<sub>Additional directories: <code>benchmarks/</code> execution-graded benchmarks + autoresearch &nbsp;·&nbsp; <code>bin/</code> CLI entry points &nbsp;·&nbsp; <code>docs/</code> architecture docs</sub>

<br />

---

<br />

## Roadmap

<table>
<tr>
<td valign="top" width="33%">

### Now

- **Per-tab model routing** - each agent tab (Orchestrator/Engineer/QA) gets its own provider and model, with Apple Foundation as lightweight chat option
- **Documentation sweep** - aligning all docs, README, and live sites with audited feature set
- **PR cleanup** - merging 12+ pending PRs with verification
- **Voice hardening** - KittenTTS integration, full-duplex Moshi backend stabilization

</td>
<td valign="top" width="33%">

### Next

- **MCP server support** - expose 8gent tools as MCP servers for external agent consumption
- **Context window compaction** - smarter compression beyond token threshold
- **Extension system** - ExtensionCrafter for autonomous source-to-extension generation
- [HyperAgent meta-improvement loop](docs/HYPERAGENT-SPEC.md)
- [Kernel fine-tuning pipeline](docs/KERNEL-FINETUNING.md) activation

</td>
<td valign="top" width="33%">

### Later

- Desktop client (Swift AppKit, `apps/lil-eight/`)
- Multi-tenant control plane via 8GI gateway
- Full autonomous issue resolution
- Personal LoRA from session training pairs
- Dead code cleanup (music/DJ package)

</td>
</tr>
</table>

<br />

---

<br />

## Slash Commands

<table>
<tr>
<td valign="top" width="50%">

| Command | What it does |
|:--------|:-------------|
| `/voice chat` | Start voice conversation mode |
| `/model <name>` | Switch LLM model |
| `/provider <name>` | Switch LLM provider |
| `/kanban` | Kanban task board |
| `/predict` | Confidence-scored step predictions |
| `/evidence` | Session evidence summary |
| `/router` | Task router + model selection |

</td>
<td valign="top" width="50%">

| Command | What it does |
|:--------|:-------------|
| `/history` | Browse past sessions |
| `/resume` | Resume a previous session |
| `/compact` | Compact current session |
| `/github` | GitHub integration |
| `/auth status` | Check auth state |
| `/debug` | Session inspector |
| `/deploy <target>` | Deploy to Vercel/Railway/Fly |
| `/music` | Toggle lofi music (ADHD mode) |
| `/pet` | Companion dock pet |
| `/rename` | Rename the current session |

</td>
</tr>
</table>

<br />

---

<br />

## Documentation

<details>
<summary><strong>Architecture &amp; Specs</strong></summary>

<br />

| Doc | What it covers |
|:----|:---------------|
| [SOUL.md](SOUL.md) | Agent persona and principles |
| [CLAUDE.md](CLAUDE.md) | Dev conventions, design system, repo rules |
| [docs/HYPERAGENT-SPEC.md](docs/HYPERAGENT-SPEC.md) | HyperAgent metacognitive self-modification spec |
| [docs/MODEL-SHOOTOUT.md](docs/MODEL-SHOOTOUT.md) | Local vs cloud model comparison results |
| [docs/MEMORY-SPEC.md](docs/MEMORY-SPEC.md) | Memory layer architecture and API reference |
| [docs/KERNEL-FINETUNING.md](docs/KERNEL-FINETUNING.md) | RL fine-tuning pipeline |
| [docs/PERSONALIZATION.md](docs/PERSONALIZATION.md) | 5-layer personalization system |
| [docs/TOOLSHED.md](docs/TOOLSHED.md) | Capability discovery and skill registry |
| [docs/permissions.md](docs/permissions.md) | Policy engine and approval gates |
| [docs/BRANCH-DECISIONS.md](docs/BRANCH-DECISIONS.md) | Architecture decision log |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to contribute |

</details>

<details>
<summary><strong>External Resources</strong></summary>

<br />

| Resource | Link |
|:---------|:-----|
| 8gent Constitution | [8gent.world/constitution](https://8gent.world/constitution) |
| Presentation Decks | [8gent.world/media/decks](https://8gent.world/media/decks) |
| Architecture Inspirations | [8gent.world/inspirations](https://8gent.world/inspirations) |

</details>

<br />

---

<br />

## Inspirations

Architecture credits. These projects informed specific parts of 8gent's design.

<table>
<tr>
<td valign="top" width="50%">

- [Hermes by ArcadeAI](https://github.com/ArcadeAI/hermes) -persistent memory and self-evolution patterns
- [CashClaw](https://github.com/nicepkg/CashClaw) -autonomous work discovery and value generation
- NemoClaw -policy-driven governance and approval gate architecture
- HyperAgents (Meta FAIR, March 2026) -metacognitive self-modification
- Hypothesis Loop -atomic commit-verify-revert development cycle

</td>
<td valign="top" width="50%">

- Blast Radius Engine -AST-based change impact estimation
- Claude Code -worktree isolation pattern for parallel agent execution
- Karpathy's autoresearch methodology -iterative prompt mutation and meta-optimization
- [SoulSpec](https://github.com/OpenSoul-org/SoulSpec) -agent persona standard
- [usecomputer](https://github.com/remorses/usecomputer) -cross-platform desktop automation via native Zig N-API
- [Quitty](https://github.com/iad1tya/Quitty) -process management and resource conservation UX

</td>
</tr>
</table>

<sub>Full list at <a href="https://8gent.world/inspirations">8gent.world/inspirations</a></sub>

<br />

---

<br />

<p align="center">
  <strong>Apache 2.0</strong> - James Spalding, Founder and Visionary
</p>

<p align="center">
  <a href="https://x.com/8gentapp">X / Twitter</a> &nbsp;·&nbsp;
  <a href="https://github.com/8gi-foundation/8gent-code">GitHub</a> &nbsp;·&nbsp;
  <a href="https://8gent.dev">8gent.dev</a> &nbsp;·&nbsp;
  <a href="https://8gent.world">8gent.world</a>
</p>

<br />

<p align="center">
  <sub>Your OS. Your rules. Your AI.</sub>
</p>
