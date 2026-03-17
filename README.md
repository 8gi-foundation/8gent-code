# 8gent Code

**The Infinite Gentleman** — Autonomous agentic coding powered by local LLMs.

> Never hit usage caps again. Run locally via Ollama or OpenRouter with BMAD method planning, 97% token savings, and autoresearch-tuned prompts that beat Claude Code on benchmarks.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Built with Bun](https://img.shields.io/badge/Built%20with-Bun-f9f1e1?logo=bun&logoColor=000)](https://bun.sh)
[![Powered by Ollama](https://img.shields.io/badge/Powered%20by-Ollama-blue)](https://ollama.ai)
[![OpenRouter](https://img.shields.io/badge/OpenRouter-Free%20Models-purple)](https://openrouter.ai)
[![Version](https://img.shields.io/badge/version-0.6.0-brightgreen)](https://github.com/PodJamz/8gent-code)
[![Benchmarks](https://img.shields.io/badge/benchmarks-39%20tests-orange)](docs/BENCHMARKS.md)
[![Twitter](https://img.shields.io/twitter/follow/james__spalding?style=social)](https://twitter.com/james__spalding)

<p align="center">
  <img src="demo.gif" alt="8gent Code Demo" width="700">
</p>

---

## ✨ What is 8gent?

8gent is an autonomous coding agent that runs entirely on your machine using local LLMs via Ollama (or free cloud models via OpenRouter). It combines the BMAD method (Breakthrough Method of Agile AI-driven Development) with AST-first code navigation and autoresearch-tuned prompts for efficient, intelligent code generation.

**Proven results:** 8gent beats Claude Code on 4 out of 5 core benchmarks using Karpathy's autoresearch methodology for iterative prompt improvement.

**The full TUI experience includes:**

- 🎭 **Stunning Animations** — Matrix rain, fire effects, DNA helix, starfield, and more
- ⚡ **ADHD Mode** — Bionic reading that makes your brain process text 2x faster
- 👻 **Ghost Suggestions** — Tab to accept intelligent command predictions
- 📋 **Kanban Board** — Visual task management with `/kanban`
- 🎨 **Beautiful UI** — Fade-in animations, typing effects, gradient text
- 🔊 **Voice Output** — TTS announcements on task completion
- 🏆 **Autoresearch** — Self-improving prompts via iterative benchmarking
- 🌐 **OpenRouter** — Free cloud models for users without local GPUs

---

## 🚀 Quick Start

### Prerequisites

1. **Install Ollama:** https://ollama.ai
2. **Install Bun:** https://bun.sh
3. **Pull a model:**
   ```bash
   ollama pull eight-1.0-q3:14b  # 8gent's fine-tuned model (primary)
   ollama pull qwen3.5           # Upstream fallback (6.6GB, optional)
   ```

### Install

```bash
# Clone and install
git clone https://github.com/PodJamz/8gent-code.git
cd 8gent-code
bun install

# Create global symlink
mkdir -p ~/.local/bin
ln -sf "$(pwd)/apps/tui/src/index.tsx" ~/.local/bin/8gent
chmod +x ~/.local/bin/8gent

# Add to PATH (if not already)
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

### Run

```bash
# Start the full TUI experience
8gent

# Or run with bun directly
bun run tui
```

---

## 🎮 Features

### 🎭 ASCII Animations

Mind-blowing terminal animations. Try them with `/animations`:

| Animation | Command | Description |
|-----------|---------|-------------|
| Matrix Rain | `/animations matrix` | Classic green falling code |
| Fire Effect | `/animations fire` | Dynamic flames at the bottom |
| DNA Helix | `/animations dna` | Rotating double helix |
| Starfield | `/animations stars` | 3D space travel effect |
| Bouncing Dots | `/animations dots` | Mesmerizing bouncing particles |
| Glitch Text | `/animations glitch` | Cyberpunk text corruption |
| Confetti | `/animations confetti` | Celebration particles |
| Waveform | `/animations wave` | Audio-style wave animation |
| Gradient Wave | `/animations gradient` | Smooth color transitions |
| Gallery | `/animations all` | Navigate all with arrow keys |

### ⚡ ADHD / Bionic Reading Mode

Enable faster reading by bolding the first half of each word:

```
Normal:   The quick brown fox jumps over the lazy dog
Bionic:   Th·e qui·ck bro·wn fox jum·ps ov·er the la·zy dog
          ↑↑  ↑↑↑    ↑↑↑     ↑↑↑   ↑↑    ↑↑
         (bold portions shown before the dot)
```

Toggle with `/adhd` or `/adhd on|off`. Your brain will thank you.

### 👻 Ghost Suggestions

Intelligent command predictions appear as you type:

- **Git-aware** — Suggests commits when on a branch
- **Plan-aware** — Shows next step from active plan
- **History-aware** — Learns from your recent commands

Press **Tab** to accept, **Esc** to dismiss.

### 📋 Kanban Board

Visual task management built-in:

```
┌─────────────────────────────────────────────────────────────────┐
│ Backlog (3)     │ In Progress (1)  │ Done (2)                  │
├─────────────────────────────────────────────────────────────────┤
│ ○ Add tests     │ ● Fix auth bug   │ ✓ Setup project           │
│ ○ Update docs   │                  │ ✓ Create components       │
│ ○ Add caching   │                  │                           │
└─────────────────────────────────────────────────────────────────┘
```

Toggle with `/kanban`. Navigate with arrow keys.

### 🧠 BMAD Method Planning

Structured planning for complex tasks:

```
User: Build a Next.js site with auth and dark mode

8gent:
┌─────────────────────────────────────────┐
│ 📋 PLAN                                 │
├─────────────────────────────────────────┤
│ 1. Initialize Next.js project           │
│ 2. Set up authentication (NextAuth)     │
│ 3. Create theme provider (dark/light)   │
│ 4. Build UI components                  │
│ 5. Add tests and verify                 │
└─────────────────────────────────────────┘
```

### 🔮 Foresight & Avenues

8gent doesn't just execute—it *thinks ahead*. The gentleman anticipates.

**Prediction System:**
- Analyzes your current task to predict the next 3-5 logical steps
- Shows upcoming work via `/predict` or `/next`
- Ghost suggestions draw from predicted steps

**Avenues Exploration:**
- Before diving deep, 8gent briefly explores multiple approaches
- Weighs trade-offs: performance vs complexity, speed vs maintainability
- Presents options with gentlemanly candor via `/avenues`

**Proactive Warnings:**
```
⚠️ Pardon the interruption, but I notice we're heading toward
   a pattern that may accumulate technical debt:

   → Adding a 4th boolean prop to <Button> suggests
     it may be time for a variant-based API instead.

   Shall I propose a refactor, or continue as planned?
```

**What 8gent watches for:**
- 🐰 **Rabbit holes** — Scope creep without explicit planning
- 💳 **Tech debt** — Quick fixes that compound over time
- 🔄 **Circular dependencies** — Architecture smells
- 📦 **Over-engineering** — Building for hypotheticals
- ⚡ **Performance traps** — N+1 queries, unbounded loops

The gentleman speaks plainly, but always with respect.

### 🎯 AST-First Code Navigation

97% token savings with symbol-level retrieval:

```bash
# Traditional: Read whole file (2,119 tokens)
cat src/parser.ts

# 8gent: Get just what you need (61 tokens)
8gent outline src/parser.ts
8gent symbol src/parser.ts::buildSymbolId
```

### 🔒 Skill Quarantine System

Safely acquire external skills with full security scanning:

```
External Repo → Quarantine → Security Scan → Abstract → Toolshed
                    ↓
         ~/.8gent/quarantine/pending/
```

**Flow:**
1. **Quarantine** — Clone external skill to sandbox
2. **Scan** — Check for dangerous patterns (command injection, data exfiltration, credentials)
3. **Abstract** — Convert to 8gent conventions with minimal token footprint
4. **Release** — Register in toolshed, available to agent

**Security Checks:**
- 🚨 Command injection (`eval`, `exec`, backticks)
- 🔐 Credential access (`.env`, API keys, private keys)
- 📡 Data exfiltration (curl POST, wget)
- 💀 System modification (`rm -rf`, `sudo`, `chmod`)
- 🎭 Code obfuscation (base64, hex encoding)

**Commands:**
```bash
/quarantine add https://github.com/user/skill  # Clone to sandbox
/quarantine scan skill-123-abc                  # Run security scan
/quarantine release skill-123-abc               # Release to toolshed
/quarantine list pending                        # View quarantined skills
```

### 🔌 Integrations

| Feature | Description |
|---------|-------------|
| **MCP** | Connect external tools via Model Context Protocol |
| **LSP** | Code intelligence via Language Server Protocol |
| **Web Search** | Search and fetch web content |
| **Multimodal** | Read images, PDFs, Jupyter notebooks |
| **Multi-Agent** | Orchestrate subagents for complex tasks |
| **Hooks** | Custom automation triggers |
| **Permissions** | Fine-grained command control |
| **Quarantine** | Secure skill acquisition with security scanning |

---

## ⌨️ Slash Commands

### Core Commands

| Command | Aliases | Description |
|---------|---------|-------------|
| `/help` | `/h`, `/?` | Show available commands |
| `/clear` | `/cls`, `/c` | Clear the screen |
| `/quit` | `/q`, `/exit` | Exit 8gent |
| `/status` | `/s`, `/st` | Show session status |

### Visual Features

| Command | Aliases | Description |
|---------|---------|-------------|
| `/animations` | `/anim`, `/fx` | Preview ASCII animations |
| `/adhd` | `/bionic`, `/focus` | Toggle bionic reading mode |
| `/kanban` | `/k`, `/board` | Toggle kanban board view |

### AI Features

| Command | Aliases | Description |
|---------|---------|-------------|
| `/model` | `/m` | Select LLM model |
| `/provider` | `/pr` | Select LLM provider |
| `/plan` | `/pl` | Show current execution plan |
| `/predict` | `/p`, `/next` | Show predicted next steps |
| `/avenues` | `/a`, `/paths` | Show all planned avenues |
| `/infinite` | `/inf`, `/∞` | Enable autonomous mode |

### Personalization

| Command | Aliases | Description |
|---------|---------|-------------|
| `/onboarding` | `/setup`, `/intro` | Start personalization setup |
| `/preferences` | `/prefs`, `/settings` | View/edit preferences |
| `/voice` | `/v` | Voice TTS settings |
| `/language` | `/lang`, `/l` | Set response language |

### Skill Management

| Command | Aliases | Description |
|---------|---------|-------------|
| `/quarantine` | `/quar`, `/sandbox` | Manage skill quarantine |
| `/toolshed` | `/shed`, `/tools` | Query available tools |
| `/skills` | `/sk` | List and manage skills |

---

## 🏆 Benchmarks: 39 Execution-Graded Tests

8gent uses [Karpathy's autoresearch methodology](https://github.com/karpathy/autoresearch) to iteratively improve its system prompts. The harness runs benchmarks in a loop, identifies weaknesses, mutates prompts, and re-runs — scores improve automatically.

**Not HumanEval. Not LeetCode.** Real freelance tasks worth $500-$1,500 each, across 15 professional domains. Every benchmark is execution-graded — code runs against `bun:test` suites or it doesn't.

### How Grading Works

- **Execution (70%)** — code is compiled, run against test assertions. Score = passed/total.
- **Keyword (30%)** — checks for domain-specific patterns (JWT, topological sort, NPV, etc.)
- **Temperature sweep** — each benchmark runs at temp 0.3, 0.5, 0.7. Best result kept.

### Battle Test Results (15 Professional Domains)

All local inference via Ollama. **$0 cost.**

| ID | Domain | Task | Score | Status |
|----|--------|------|-------|--------|
| BT001 | Software Engineering | SaaS Auth System — JWT, Roles, Rate Limiting | **94** | PASS |
| BT002 | Software Engineering | Event-Driven Architecture — Pub/Sub, DLQ, Retry | **92** | PASS |
| BT003 | Data Engineering | Data Pipeline — Stream Processing, Validation | **100** | PERFECT |
| BT004 | Developer Tools | CLI Framework — Parser, Help, Flags, Subcommands | 53 | Improving |
| BT005 | Software Engineering | State Machine — Typed Transitions, Guards, Actions | **92** | PASS |
| BT006 | Financial Consulting | Financial Dashboard — ROI, NPV, IRR, EBITDA | 54 | Improving |
| BT007 | Digital Marketing | SEO Audit Engine — Meta, Scoring, Core Web Vitals | **96** | PASS |
| BT008 | Marketing Automation | Email Campaign — Templates, A/B Testing, Analytics | 54 | Improving |
| BT009 | DevOps | CI/CD Pipeline — DSL, Dependency Graph, YAML | 33 | Improving |
| BT010 | Design Systems | Design Tokens — Multi-Format Export, Scales | 39 | Improving |
| BT011 | Video Production | Video Planner — Scene Graph, Timeline, FFmpeg | **100** | PERFECT |
| BT012 | Music Technology | Music Theory — Notes, Chords, Scales, Progressions | **81** | PASS |
| BT013 | Data Visualization | Charts, Scales, Layouts in SVG/ASCII | 30 | Improving |
| BT014 | AI Consulting | Report Generator — Assessment, Roadmap | **95** | PASS |
| BT015 | Cybersecurity | Security Audit — Scanner, Vuln DB, Reports | 30 | Improving |

**Iteration 1:** Average 69, 8/15 passing. **Iteration 2 in progress** — BT001 already jumped 85 → 94 with mutations.

### All Categories (39 Benchmarks)

| Category | Count | Focus |
|----------|-------|-------|
| Bug Fixing | 3 | Race conditions, memory leaks, null refs |
| File Manipulation | 1 | Input validation with structured errors |
| Feature Implementation | 1 | LRU cache with TTL and stats |
| Fullstack | 3 | REST API auth, task queues, state machines |
| Agentic | 7 | Config parsing, ETL, reverse engineering, debugging |
| UI Design | 8 | Neumorphic, glassmorphism, 3D, animations, responsive |
| Battle Test | 15 | 15 professional domains (see table above) |

### Key Findings

1. **Knowledge vs Execution gap** — models score 100% on keywords but 0% on execution for complex tasks. They know every pattern but can't produce coordinated code that runs.
2. **Temperature matters** — same model scores 43 at temp=0.3 and 92 at temp=0.7 on the same benchmark.
3. **Mutations compound** — BT001 went 85→94 after one round of mutations. The system learns from its own failures.
4. **Multi-model fallback** — devstral scored 100 on BT003 when qwen3.5 timed out. Different models excel at different domains.

### Run Benchmarks

```bash
# Single pass (all benchmarks)
bun run benchmark:v2

# Autoresearch loop (iterative improvement)
CATEGORY=battle-test MAX_ITERATIONS=5 bun run benchmark:loop

# Overnight continuous runner (all categories)
bash benchmarks/autoresearch/overnight-runner.sh
```

Full benchmark details: [benchmarks/README.md](benchmarks/README.md)

---

## 🌐 OpenRouter Free Models

No local GPU? No problem. 8gent supports free cloud models via OpenRouter:

```bash
# Set your OpenRouter API key
export OPENROUTER_API_KEY=sk-or-...

# 8gent auto-detects free models
8gent --provider openrouter
```

**Free models available:**
- `openrouter/auto` — Smart routing to best free model
- `qwen/qwen3-coder-480b:free` — Top-tier coding
- `meta-llama/llama-3.3-70b-instruct:free` — Strong general purpose
- `google/gemma-3-27b-it:free` — Efficient mid-size
- `deepseek/deepseek-chat-v3-0324:free` — DeepSeek V3

---

## 💰 Token Savings

Real benchmarks from 8gent's codebase:

| Metric | Traditional | AST-First | Savings |
|--------|-------------|-----------|---------|
| Average file read | 1,027 tokens | 546 tokens | **46.8%** |
| Symbol retrieval | 2,119 tokens | 61 tokens | **97.1%** |
| 10K operations | $3,084 | $1,640 | **$1,444 saved** |

---

## 🏗️ Architecture

```
User Intent
    ↓
8gent TUI (Ink/React)
    ├── Animations & Effects
    ├── ADHD Mode
    ├── Ghost Suggestions
    └── Kanban Board
    ↓
Proactive Planner (BMAD)
    ↓
Multi-Agent Orchestration
    ↓
Toolshed (capability discovery)
    ↓
┌─────────────────────────────────────┐
│ MCP │ LSP │ Web │ Shell │ AST │ FS │
└─────────────────────────────────────┘
    ↓
Evidence Collection & Validation
    ↓
Completion Report + Voice Output
```

### Core Packages

| Package | Purpose |
|---------|---------|
| `apps/tui` | Terminal UI with animations, ADHD mode, kanban |
| `packages/eight` | Main agent loop, REPL, and providers (Ollama, OpenRouter) |
| `packages/ast-index` | TypeScript AST parsing |
| `packages/mcp` | MCP client implementation |
| `packages/lsp` | LSP client for code intelligence |
| `packages/orchestration` | Multi-agent coordination |
| `packages/planning` | Proactive planning engine |
| `packages/quarantine` | Skill security sandbox and abstraction |
| `packages/toolshed` | Capability discovery and skill registry |
| `packages/validation` | Evidence collection |
| `packages/reporting` | Completion reports |
| `packages/permissions` | Command permission system |
| `packages/hooks` | Automation hooks |
| `packages/skills` | Skill framework |
| `packages/tools` | Web, PDF, image, notebook tools |
| `packages/personality` | The Infinite Gentleman voice |
| `benchmarks/` | 44 benchmarks across 12 categories + autoresearch harness |
| `config/metaclaw.yaml` | MetaClaw RL fine-tuning configuration |

### Kernel Fine-Tuning (Experimental)

8gent can continuously improve its local models via [MetaClaw](https://github.com/aiming-lab/MetaClaw) RL fine-tuning. Every coding session becomes training data — a judge model scores responses, and GRPO evolves a LoRA adapter on top of your base model. The model gets better at *your* workflows over time.

```
8gent TUI ──> MetaClaw Proxy (:30000) ──> Ollama (:11434)
                    │
              Judge LLM scores responses async
                    │
              GRPO LoRA training during idle/sleep
                    │
              Hot-swap adapter ──> model improves
```

**How to enable:**

```bash
# 1. Install MetaClaw
pip install -e ".[rl,evolve,scheduler]"

# 2. Point 8gent through the proxy
export METACLAW_PROXY_URL=http://localhost:30000

# 3. Start MetaClaw (uses config/metaclaw.yaml)
metaclaw start

# 4. Run 8gent normally — sessions now generate training signal
bun run tui

# 5. Validate a checkpoint against benchmarks
bun run benchmarks/autoresearch/validate-checkpoint.ts
```

**Recommended base models:**

| Model | Use Case |
|-------|----------|
| `eight-1.0-q3:14b` | **Primary** — 8gent's own fine-tuned model, code-native, fits LoRA on single GPU (~12GB VRAM) |
| `qwen3.5:latest` | Fallback — strongest upstream coding benchmarks before Eight fine-tuning |

#### Model Versioning

Eight models follow a strict naming convention: **`eight-{major.minor.patch}-q{gen}:{params}`**

| Segment | Meaning | Example |
|---------|---------|---------|
| `major` | Base model change (e.g. new upstream weights) | `1` |
| `minor` | Judge-validated improvement (Gemini Flash confirms score gain) | `0` |
| `patch` | Nightly build / incremental training run | `0` |
| `q{gen}` | Quantization generation | `q3` |
| `{params}` | Parameter count | `14b` |

The `version-manager.ts` module in `packages/eight/` manages promotions: a nightly checkpoint only becomes a new minor version when the Gemini Flash judge confirms it outperforms the current release on the autoresearch benchmark suite.

Training runs in **MadMax mode** by default: weight updates are deferred to idle periods and sleep hours so they never interrupt active coding sessions. The autoresearch benchmark suite serves as a regression gate — bad checkpoints get rolled back automatically.

#### Three-Layer Model Architecture

8gent models are composed of three stacked layers:

| Layer | What | Source |
|-------|------|--------|
| **Layer 1: Base Model** | Upstream weights (e.g. `qwen3:14b`) | Ollama registry |
| **Layer 2: Eight LoRA** | Centralized fine-tune from autoresearch benchmarks | Shipped with each Eight release |
| **Layer 3: Personal LoRA** | User's local fine-tune on their own coding patterns | `~/.8gent/personal-lora/` |

Layers stack at inference time: base weights + Eight adapter + personal adapter. When a new Eight version releases (Layer 2 update), users are prompted to retrain their personal module (Layer 3) so it aligns with the updated weights.

See [docs/KERNEL-FINETUNING.md](docs/KERNEL-FINETUNING.md) for the full architecture and phase plan.

---

## 📂 Project Structure

```
📂 8gent-code/
├── apps/
│   └── tui/                    # Full TUI Experience
│       └── src/
│           ├── app.tsx         # Main app with ADHD mode context
│           └── components/
│               ├── advanced-animations.tsx   # Matrix, Fire, DNA, etc.
│               ├── animation-showcase.tsx    # Gallery view
│               ├── bionic-text.tsx          # ADHD reading mode
│               ├── command-input.tsx        # Ghost suggestions
│               ├── fade-transition.tsx      # Fade/Pop animations
│               ├── message-list.tsx         # Typing effects
│               ├── plan-kanban.tsx          # Kanban board
│               ├── progress-bar.tsx         # Wave progress
│               ├── status-bar.tsx           # Model/branch info
│               └── typing-text.tsx          # Character/word animation
├── packages/
│   ├── agent/              # Main agent
│   ├── ast-index/          # AST parsing (97% savings)
│   ├── hooks/              # Hook system
│   ├── lsp/                # LSP client
│   ├── mcp/                # MCP client
│   ├── orchestration/      # Multi-agent
│   ├── permissions/        # Permissions
│   ├── personality/        # Brand voice
│   ├── planning/           # BMAD planner
│   ├── reporting/          # Completion reports
│   ├── skills/             # Skill framework
│   ├── tasks/              # Task management
│   ├── tools/              # Web, PDF, image tools
│   ├── toolshed/           # Tool registry
│   ├── types/              # Shared types
│   └── validation/         # Evidence collection
├── benchmarks/
│   ├── autoresearch/       # Karpathy-style iterative improvement
│   │   └── harness.ts      # Main autoresearch loop
│   ├── categories/         # 12 benchmark categories (44 tests)
│   │   ├── bug-fixing/
│   │   ├── feature-implementation/
│   │   ├── threejs/
│   │   ├── react-native/
│   │   ├── nextjs/
│   │   ├── creative/
│   │   ├── human-skills/
│   │   └── ...
│   ├── fixtures/           # Test fixtures for benchmarks
│   └── results.tsv         # Benchmark results log
├── docs/                   # Documentation
└── scripts/                # Demos and utilities
```

---

## 🎨 TUI Components

### Message Animations

- **FadeIn** — Smooth opacity transitions
- **PopIn** — Scale-up entrance effects
- **TypingText** — Character-by-character reveal
- **WordByWord** — Word-level streaming for long content
- **GlowText** — Pulsing highlight effect

### Processing Indicators

- **AnimatedSpinner** — Multiple spinner styles (dots, line, arc, bounce)
- **StepIndicator** — Multi-step progress (Plan → Tools → Execute)
- **WaveProgress** — Animated sine wave progress bar

### Interactive Elements

- **GhostSuggestion** — Dim text predictions with Tab-to-accept
- **SlashCommandHelp** — Auto-complete dropdown for commands
- **StatusBar** — Real-time model, branch, and mode indicators

---

## 🔧 Configuration

### MCP Servers

```json
{
  "servers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"]
    }
  }
}
```

### Permissions

```json
{
  "allowedPatterns": ["npm *", "git *", "bun *"],
  "deniedPatterns": ["rm -rf /", "sudo rm -rf"],
  "autoApprove": false
}
```

### Hooks

```json
{
  "hooks": [{
    "type": "onComplete",
    "command": "say -v Ava 'Task completed'"
  }]
}
```

---

## 🤝 Contributing

1. Fork the repo
2. Create your feature branch (`git checkout -b feature/amazing`)
3. Run benchmarks to verify savings (`bun run benchmark`)
4. Commit your changes
5. Push to the branch
6. Open a Pull Request

See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

---

## 📜 The Name

**8gent** combines two ideas:

- **8** → infinity (∞ rotated)
- **gent** → gentleman / agent

An **infinite gentleman**: a disciplined system that grows without increasing prompt size.

---

## 📄 License

MIT © James Spalding

---

<p align="center">
  <strong>The Infinite Gentleman. Always at your service.</strong><br><br>
  <a href="https://github.com/PodJamz/8gent-code">⭐ Star on GitHub</a> ·
  <a href="https://twitter.com/james__spalding">🐦 Follow on Twitter</a>
</p>
