# Contributing to 8gent Code

Welcome to 8gent Code - the open source autonomous coding agent TUI. This guide covers everything you need to get productive in the codebase.

---

## Prerequisites

- **Bun** (v1.1+) - runtime and package manager
- **Ollama** - local LLM inference (default provider)
- **Git** - version control
- **macOS or Linux** - primary supported platforms

Optional:
- **mpv + yt-dlp** - for music/DJ features
- **sox** - for synth audio generation

---

## Dev Environment Setup

```bash
# 1. Clone the repo
git clone https://github.com/PodJamz/8gent-code.git
cd 8gent-code

# 2. Install dependencies
bun install

# 3. Install Ollama and pull the default model
# https://ollama.ai - download and install
ollama pull qwen3:4b

# 4. Launch the TUI
bun run tui

# 5. (Optional) Launch Lil Eight - the desktop pet companion
bun run pet
```

If you prefer cloud models over local, set an OpenRouter API key:

```bash
export OPENROUTER_API_KEY="your-key-here"
```

No API key is required to start. Local-first is the default.

---

## Running Things

| Command | What it does |
|---------|-------------|
| `bun run tui` | Launch the terminal UI |
| `bun run start` | Run the agent loop directly (no TUI) |
| `bun run pet` | Build and open Lil Eight desktop pet |
| `bun run pet:build` | Build Lil Eight without opening |
| `bun run pet:kill` | Kill the running Lil Eight process |
| `bun run benchmark:v2` | Run a single benchmark pass |
| `CATEGORY=battle-test bun run benchmark:loop` | Run the autoresearch benchmark loop |
| `bun run cli` | Run the CLI entrypoint |

### Daemon (Eight Kernel)

The Eight kernel runs as a persistent daemon. For local development:

```bash
bun run packages/daemon/index.ts
```

Production daemon lives at `eight-vessel.fly.dev` (Fly.io Amsterdam).

### Lil Eight (Desktop Pet)

Lil Eight is a macOS desktop pet companion built with Swift. It lives in `apps/lil-eight/`.

```bash
bun run pet          # build + open
bun run pet:build    # build only
bun run pet:kill     # kill running instance
bun run pet:log      # tail the log file
```

---

## Project Structure

```
8gent-code/
  apps/                    # User-facing applications
    tui/                   # Terminal UI (Ink v6 + React)
    clui/                  # Desktop overlay (Tauri 2.0)
    dashboard/             # Web dashboard
    debugger/              # Debug inspector
    demos/                 # Demo scenes and presentations
    installer/             # Install wizard
    lil-eight/             # Desktop pet companion (Swift/macOS)
    landing/               # Landing page
    8gent-one/             # Unified app shell

  packages/                # Core library packages (~45 total)
    eight/                 # Agent loop, tools, system prompt
    memory/                # SQLite + FTS5 episodic/semantic memory
    music/                 # DJ, radio, synth, MusicGen
    orchestration/         # Worktree pool, delegation, macro-actions
    permissions/           # NemoClaw YAML policy engine
    self-autonomy/         # Reflection, evolution, HyperAgent
    validation/            # Checkpoint-verify-revert healing
    proactive/             # Bounty scanner, opportunity pipeline
    ast-index/             # Import graph, change impact analysis
    tools/                 # Browser, file ops, shell tools
    daemon/                # Persistent vessel daemon
    kernel/                # RL fine-tuning pipeline (GRPO)
    ai/                    # AI SDK provider abstractions
    personality/           # Brand voice, Infinite Gentleman
    quarantine/            # Code scanner and abstractor
    ...

  benchmarks/              # Benchmark suite
    categories/            # Benchmark definitions by category
    fixtures/              # Test fixtures and data
    autoresearch/          # Autonomous research loop
    grader.ts              # AI + execution grading
    runner.ts              # Benchmark execution engine
    types.ts               # Type definitions

  docs/                    # Architecture specs
  config/                  # YAML configuration files
  bin/                     # CLI entrypoints
```

---

## The 9 Powers

Eight's capabilities are organized into 9 self-contained "Power" packages. Each is CLI-callable and usable by any agent in the system.

| # | Power | Package | What it does |
|---|-------|---------|-------------|
| 1 | Memory | `packages/memory/` | SQLite + FTS5 + embeddings, episodic/semantic/procedural |
| 2 | DJ & Music | `packages/music/` | YouTube streaming, internet radio, synth, MusicGen |
| 3 | Worktree | `packages/orchestration/` | Concurrent worktree pool, delegation, messaging |
| 4 | Policy | `packages/permissions/` | YAML deny-by-default policy engine |
| 5 | Evolution | `packages/self-autonomy/` | Reflection, Bayesian confidence, meta-mutation |
| 6 | Healing | `packages/validation/` | Checkpoint-verify-revert loop, atomic snapshots |
| 7 | Entrepreneurship | `packages/proactive/` | Bounty scanner, capability matcher |
| 8 | AST | `packages/ast-index/` | Import graph, test mapping, impact estimation |
| 9 | Browser | `packages/tools/browser/` | Fetch, DuckDuckGo scraper, HTML-to-text, disk cache |

---

## Adding a New Package

Follow the 9 Powers pattern. Every package should be self-contained and independently usable.

### 1. Create the directory

```bash
mkdir -p packages/your-package
```

### 2. Add a `package.json`

```json
{
  "name": "@8gent/your-package",
  "version": "1.0.0",
  "type": "module",
  "main": "index.ts"
}
```

### 3. Create `index.ts` with a clean public API

Export a single class or a small set of functions. The package should work standalone:

```typescript
// packages/your-package/index.ts
export class YourPower {
  async init(): Promise<void> { /* setup */ }
  async run(input: string): Promise<string> { /* core logic */ }
}
```

### 4. Wire it into the agent (if applicable)

If the package provides tools for the agent, register them in `packages/eight/tools.ts`.

### 5. Constraints

- Package must work with `bun run packages/your-package/index.ts` standalone
- No circular dependencies between packages
- Keep the public API surface small
- Include types - no `any` exports
- If it touches more than 3 existing files, pause and confirm scope with a maintainer

---

## Adding a Benchmark

Benchmarks live in `benchmarks/categories/`. Each category has a `benchmarks.ts` file defining test cases.

### 1. Choose or create a category

Existing categories include: `bug-fixing`, `file-manipulation`, `feature-implementation`, `fullstack`, `agentic`, `ui-design`, `battle-test`, `long-horizon`, `code-review`, `documentation`, `creative`, `custom-tooling`, `integration`, `multi-file`, `nextjs`, `react-native`, `test-generation`, `threejs`, and more.

### 2. Define the benchmark

Add an entry to the category's `benchmarks.ts`:

```typescript
import type { BenchmarkDefinition } from "../../types";

export const benchmarks: BenchmarkDefinition[] = [
  {
    id: "your-benchmark-id",
    category: "feature-implementation",
    title: "Short description of what is tested",
    difficulty: "medium",       // "easy" | "medium" | "hard"
    prompt: "The task prompt sent to the LLM...",
    keywords: ["expected", "output", "tokens"],
    keywordThreshold: 2,
    testExecution: true,
    testFile: "fixtures/your-test.test.ts",
    timeoutMs: 30000,
  },
];
```

### 3. Add test fixtures (if using execution grading)

Place test files in `benchmarks/fixtures/`. The harness copies them into a work directory before running.

### 4. Run it

```bash
bun run benchmark:v2
```

### Grading rules

- **AI judge** - a model evaluates the output semantically (preferred method)
- **Execution** - `bun test` runs against the output
- **Never use string matching** (regex, `.includes()`) to evaluate agent output. Always use the AI SDK as a judge.
- **No dollar values** on benchmarks. Describe what tasks test, not theoretical cost.

---

## Creating a Skill

Skills are modular capabilities the agent can learn and invoke. They live in `packages/skills/`.

A skill needs:
- A clear trigger (when should the agent use this?)
- An execution function
- Optional configuration

```typescript
// packages/skills/your-skill.ts
import { registerSkill } from "./index";

registerSkill({
  name: "your-skill",
  description: "One sentence explaining what it does",
  execute: async (context) => {
    // Implementation
    return result;
  },
});
```

Follow existing patterns in `packages/skills/` for structure and registration.

---

## Code Style

### Absolute Rules (Non-Negotiable)

1. **No em dashes.** Never use the character. Use hyphens (-) or rewrite the sentence.
2. **No purple/pink/violet.** Hues 270-350 are banned everywhere. See `BRAND.md`.
3. **No dollar values on benchmarks.** Describe what tasks test, not theoretical cost.
4. **No stat padding.** Only state numbers you can prove with evidence.
5. **No enthusiasm inflation.** State what was done, what works, what doesn't.

### TypeScript

- Runtime is Bun. Use Bun APIs where available (`Bun.file()`, `bun:sqlite`, etc.)
- `type: "module"` everywhere. ESM imports only.
- Prefer explicit types over `any`.
- Use the Vercel AI SDK (`ai` package) for all LLM interactions.

### TUI Colors

Terminal users have different themes. Never use `gray`, `white`, or `black` as color props in Ink components.

| Purpose | Use |
|---------|-----|
| Muted text | `dimColor` prop |
| Emphasis | `bold` prop |
| Assistant text | `color="cyan"` |
| User text | `color="yellow"` |
| Success | `color="green"` |
| Error | `color="red"` |
| Borders | `color="blue"` or `color="cyan"` |

Safe named colors: `red`, `green`, `yellow`, `blue`, `cyan`. That is it.

### Brand

- Accent color: `#E8610A` (orange)
- Fonts: Fraunces (headings, weight 800), Inter (body), JetBrains Mono (code)
- Full rules in `BRAND.md`

---

## PR Process

### Branch Naming

All contributions use **quarantine branches**:

```
quarantine/your-feature-name
```

The quarantine prefix signals that the branch needs review before merging to main.

### Workflow

1. Create your branch: `git checkout -b quarantine/your-feature-name`
2. Make your changes. Keep the blast radius small - ideally 3 files or fewer.
3. Test before pushing. Run `bun run tui` to verify the TUI still launches.
4. Push and open a PR against `main`.
5. PRs are reviewed for:
   - Brand compliance (no em dashes, no purple, no stat padding)
   - Scope discipline (does it do one thing well?)
   - Evidence (benchmarks, tests, or demos proving the feature works)

### Commit Messages

Follow conventional commits:

```
feat: add memory consolidation background job
fix: prevent crash when Ollama is not running
docs: update benchmark categories list
```

### What Makes a Good PR

- Solves one problem clearly
- Includes a measurable outcome (benchmark score, test, demo)
- Does not break existing functionality
- Follows the code style rules above
- Has a clear description of what changed and why

---

## Versioning

Version lives in 3 places - keep them in sync:
- `package.json` (source of truth)
- `bin/8gent.ts`
- `README.md` version badge

SemVer strictly: PATCH for fixes, MINOR for features, MAJOR for breaking changes.

---

## Architecture Principles

These are not optional. They are how the project works.

1. **Free and local by default.** No API keys to start. Ollama first. Cloud is opt-in.
2. **Self-evolving.** Eight improves every session. Lessons persist. Skills accumulate.
3. **Hyper-personal.** Two users should have different experiences after a week.
4. **Design first.** Think about the interaction before writing code.
5. **Smallest thing that works.** Not the most impressive - the smallest thing that ships.

---

## Getting Help

- Read `CLAUDE.md` for the full project context and rules
- Read `BRAND.md` for design and color rules
- Check `docs/` for architecture specs (HYPERAGENT-SPEC, MEMORY-SPEC, MODEL-SHOOTOUT)
- Check `benchmarks/README.md` for benchmark documentation
- Open an issue if something is broken or unclear
