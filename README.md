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
  <a href="https://8gentos.com"><img src="https://img.shields.io/badge/OS-In_Dev-E8610A?style=for-the-badge&labelColor=1A1612" alt="OS In Dev" /></a>
  <a href="https://github.com/PodJamz/8gent-code"><img src="https://img.shields.io/badge/Code-Open_Source-2D8A56?style=for-the-badge&labelColor=1A1612" alt="Code Open Source" /></a>
  <a href="https://8gent.world"><img src="https://img.shields.io/badge/World-Live-2D8A56?style=for-the-badge&labelColor=1A1612" alt="World Live" /></a>
  <a href="https://8gent.games"><img src="https://img.shields.io/badge/Games-Live-2D8A56?style=for-the-badge&labelColor=1A1612" alt="Games Live" /></a>
</p>

<p align="center">
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-E8610A?style=for-the-badge&labelColor=1A1612" alt="MIT License" /></a>
  <a href="https://8gent.dev"><img src="https://img.shields.io/badge/version-1.0.0-2D8A56?style=for-the-badge&labelColor=1A1612" alt="v1.0.0" /></a>
  <a href="https://eight-vessel.fly.dev"><img src="https://img.shields.io/badge/daemon-Fly.io_Amsterdam-E8610A?style=for-the-badge&labelColor=1A1612" alt="Daemon" /></a>
</p>

<br />

---

<br />

## The Ecosystem

<p align="center"><sub>6 products &nbsp;·&nbsp; 6 domains &nbsp;·&nbsp; 1 constitution</sub></p>

<br />

<table>
<tr>
<td valign="top" width="33%">

**8gent OS** — [8gentos.com](https://8gentos.com)<br />
<sub>Parent site. Paid product. Revenue engine.</sub>

**8gent Code** — [8gent.dev](https://8gent.dev)<br />
<sub>Open source developer agent. Free on-ramp. <em>(this repo)</em></sub>

</td>
<td valign="top" width="33%">

**8gent** — [8gent.app](https://8gent.app)<br />
<sub>Consumer GUI client for the OS.</sub>

**8gent World** — [8gent.world](https://8gent.world)<br />
<sub>Ecosystem story, docs, <a href="https://8gent.world/media/decks">14 presentation decks</a>.</sub>

</td>
<td valign="top" width="33%">

**8gent Games** — [8gent.games](https://8gent.games)<br />
<sub>Agent simulation playground.</sub>

**8gent Jr** — [8gentjr.com](https://8gentjr.com)<br />
<sub>AI assistant for kids. Accessibility first. Free forever.</sub>

</td>
</tr>
</table>

<p align="center">
  <sub><a href="https://8gent.world/constitution">Constitution</a> &nbsp;·&nbsp; <a href="https://8gent.world/inspirations">Inspirations</a></sub>
</p>

<br />

---

<br />

## Quick Start

```bash
npm install -g @podjamz/8gent-code
8gent
```

That's it. Ollama runs locally by default - if you don't have it, 8gent will guide you through setup on first launch.

### From source (contributors)

```bash
git clone https://github.com/PodJamz/8gent-code.git && cd 8gent-code && bun install
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
<sub>Auto-selects from best free models on OpenRouter. Runs Qwen 3.5 via Ollama locally. Task router classifies prompts (code / reasoning / simple / creative) and picks the best model automatically.</sub>

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
<sub>Metacognitive self-modification. The agent can improve how it improves — meta-config is editable while the evaluation protocol stays human-controlled.</sub>

<br />

**AutoResearch**<br />
<sub>Overnight improvement loops (Karpathy-style). Runs benchmarks, mutates system prompts, re-tests. Meta-optimizer also tunes few-shots, model routing, and grading weights.</sub>

<br />

**Voice chat**<br />
<sub><code>/voice chat</code> starts a half-duplex conversation loop. Speak, Eight transcribes, thinks, and speaks back. ESC to interrupt mid-speech.</sub>

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
<sub>Post-session reflection, Bayesian skill confidence, HyperAgent meta-mutation, self-improvement DB</sub>

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

## Voice Chat

Half-duplex voice conversation with Eight. Requires sox and whisper.cpp:

```bash
brew install sox whisper-cpp
```

In the TUI, type `/voice chat` to start. Eight listens (sox with silence detection), transcribes (whisper.cpp local or OpenAI cloud fallback), thinks (agent loop), and speaks back (macOS `say`). Press ESC to interrupt mid-speech or exit voice mode.

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

<p align="center"><sub>Execution-graded tests across professional domains. All local inference via Ollama.<br />Code compiles and runs against <code>bun:test</code> suites, or it fails. No string matching, no vibes.</sub></p>

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
  tui/           Ink v6 terminal UI (main interface)
  clui/          Tauri 2.0 desktop overlay (scaffolded)
  dashboard/     Next.js admin panel
  debugger/      Session debugger
  demos/         Remotion video generation
  installer/     Interactive install wizard
```

</td>
<td valign="top" width="50%">

### Packages

```
packages/
  eight/         Core agent engine (Vercel AI SDK)
  daemon/        Persistent vessel daemon (Fly.io)
  ai/            Provider abstraction (Ollama, OpenRouter)
  memory/        SQLite + FTS5 persistent memory
  orchestration/ WorktreePool, macro actions
  permissions/   NemoClaw YAML policy engine
  self-autonomy/ Evolution, reflection, HyperAgent
  validation/    Self-healing executor
  proactive/     Business agents, opportunity scanner
  ast-index/     Blast radius engine
  tools/         Browser, actuators, filesystem, shell
  voice/         STT (whisper.cpp) + voice chat loop
  kernel/        RL fine-tuning pipeline (off by default)
  personality/   Brand voice, "Infinite Gentleman"
  telegram/      Telegram bot portal
  auth/          Clerk auth + GitHub integration
  db/            Convex reactive database
  control-plane/ Multi-tenant management
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

- Memory v1 enhancements: procedural memory and lease-based job queue landed. Contradiction detection, health introspection, and checkpointing in progress.
- Model shootout iteration: improving autonomous task completion rates after 0/5 in first round.
- Daemon reliability: 4-strategy retry loop landed.

</td>
<td valign="top" width="33%">

### Next

- [HyperAgent meta-improvement loop](docs/HYPERAGENT-SPEC.md)
- [Kernel fine-tuning pipeline](docs/KERNEL-FINETUNING.md) activation (off by default)
- Personal LoRA from session training pairs

</td>
<td valign="top" width="33%">

### Later

- Desktop client (Tauri 2.0, scaffolded in `apps/clui/`)
- Multi-tenant control plane
- Full autonomous issue resolution

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
| `/voice start` | Push-to-talk recording |
| `/model <name>` | Switch LLM model |
| `/board` | Kanban task board |
| `/predict` | Confidence-scored step predictions |
| `/momentum` | Velocity stats |
| `/evidence` | Session evidence summary |

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
| `/throughput` | Token throughput stats |
| `/scorecard` | Ability scorecard metrics |
| `/soul` | Current persona calibration |
| `/router` | Task router + model selection |
| `/music` | Toggle lofi music (ADHD mode) |
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

- [Hermes by ArcadeAI](https://github.com/ArcadeAI/hermes) — persistent memory and self-evolution patterns
- [CashClaw](https://github.com/nicepkg/CashClaw) — autonomous work discovery and value generation
- NemoClaw — policy-driven governance and approval gate architecture
- HyperAgents (Meta FAIR, March 2026) — metacognitive self-modification
- Hypothesis Loop — atomic commit-verify-revert development cycle

</td>
<td valign="top" width="50%">

- Blast Radius Engine — AST-based change impact estimation
- Claude Code — worktree isolation pattern for parallel agent execution
- Karpathy's autoresearch methodology — iterative prompt mutation and meta-optimization
- [SoulSpec](https://github.com/OpenSoul-org/SoulSpec) — agent persona standard

</td>
</tr>
</table>

<sub>Full list at <a href="https://8gent.world/inspirations">8gent.world/inspirations</a></sub>

<br />

---

<br />

<p align="center">
  <strong>MIT</strong> — James Spalding
</p>

<p align="center">
  <a href="https://x.com/8gentapp">X / Twitter</a> &nbsp;·&nbsp;
  <a href="https://github.com/PodJamz/8gent-code">GitHub</a> &nbsp;·&nbsp;
  <a href="https://8gent.dev">8gent.dev</a> &nbsp;·&nbsp;
  <a href="https://8gent.world">8gent.world</a>
</p>

<br />

<p align="center">
  <sub>Your OS. Your rules. Your AI.</sub>
</p>
