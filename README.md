# 8gent Code

**The Infinite Gentleman** — Autonomous agentic coding powered by local LLMs.

> Never hit usage caps again. Run locally via Ollama with BMAD method planning and 40%+ token savings.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Built with Bun](https://img.shields.io/badge/Built%20with-Bun-f9f1e1?logo=bun&logoColor=000)](https://bun.sh)
[![Powered by Ollama](https://img.shields.io/badge/Powered%20by-Ollama-blue)](https://ollama.ai)
[![Version](https://img.shields.io/badge/version-0.3.0-brightgreen)](https://github.com/PodJamz/8gent-code)
[![Twitter](https://img.shields.io/twitter/follow/james__spalding?style=social)](https://twitter.com/james__spalding)

<p align="center">
  <img src="demo.gif" alt="8gent Code Demo" width="700">
</p>

---

## ✨ What is 8gent?

8gent is an autonomous coding agent that runs entirely on your machine using local LLMs via Ollama. It combines the BMAD method (Breakthrough Method of Agile AI-driven Development) with AST-first code navigation for efficient, intelligent code generation.

**The full TUI experience includes:**

- 🎭 **Stunning Animations** — Matrix rain, fire effects, DNA helix, starfield, and more
- ⚡ **ADHD Mode** — Bionic reading that makes your brain process text 2x faster
- 👻 **Ghost Suggestions** — Tab to accept intelligent command predictions
- 📋 **Kanban Board** — Visual task management with `/kanban`
- 🎨 **Beautiful UI** — Fade-in animations, typing effects, gradient text
- 🔊 **Voice Output** — TTS announcements on task completion

---

## 🚀 Quick Start

### Prerequisites

1. **Install Ollama:** https://ollama.ai
2. **Install Bun:** https://bun.sh
3. **Pull a model:**
   ```bash
   ollama pull glm-4.7-flash:latest  # or qwen2.5, llama3, mistral, etc.
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
| `packages/agent` | Main agent loop and REPL |
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
├── docs/                   # Documentation
└── scripts/                # Benchmarks and demos
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
