# 8gent Code

**Your local Claude Code alternative™**

> Terminal-first agentic coding powered by local LLMs (Ollama) with BMAD method and 40%+ token savings.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Built with Bun](https://img.shields.io/badge/Built%20with-Bun-f9f1e1?logo=bun&logoColor=000)](https://bun.sh)
[![Powered by Ollama](https://img.shields.io/badge/Powered%20by-Ollama-blue)](https://ollama.ai)
[![Score: 80/100](https://img.shields.io/badge/Benchmark-80%2F100-brightgreen)](https://github.com/8gent/8gent-code#benchmarks)
[![Twitter](https://img.shields.io/twitter/follow/8gi-foundation?style=social)](https://twitter.com/8gi-foundation)

<p align="center">
  <img src="demo.gif" alt="8gent Code Demo" width="700">
</p>

---

## Agentic Mode (BMAD Method)

8gent runs fully autonomous coding tasks using the **BMAD Method** (Breakthrough Method of Agile AI-driven Development):

```bash
# Interactive mode
bun run packages/agent/index.ts

# Or run a task directly
bun run packages/agent/index.ts "Build a Next.js site with landing page and dark mode toggle"
```

### Slash Commands

| Command | Description |
|---------|-------------|
| `/model` | Show current model |
| `/model <name>` | Switch to a different model |
| `/models` | List available Ollama models |
| `/plan <task>` | Create a plan without executing |
| `/status` | Show model, working dir, history length |
| `/help` | Show all commands |
| `/clear` | Clear conversation history |
| `/exit` | Exit the REPL |

### Benchmark: 8gent vs Claude Code

Tested on identical task: Build Next.js site with landing, about, contact, dark/light toggle, responsive design, git commits.

| Agent | Time | Score |
|-------|------|-------|
| Claude Code (Opus 4.5) | ~5 min | **80/100** |
| 8gent v2 (GLM 4.7 Flash) | ~8 min | **80/100** |

**TIE!** Free local inference now matches Claude Code quality.

---

## The Problem

AI coding tools are hitting usage limits because they read entire files when they only need specific functions. This wastes tokens and money.

```
❌ Traditional: search → read entire file → guess → patch
✅ 8gent:       plan → retrieve symbol → compose → verify
```

## The Solution

**8gent** extracts symbols from your codebase using AST parsing, so the AI only sees what it needs.

```bash
# Instead of reading a 2,119 token file...
8gent outline src/parser.ts

# ...get just the 61 tokens you need:
8gent symbol src/parser.ts::buildSymbolId
```

**Result:** 97% less tokens, 97% less cost.

---

## Benchmarks

Real results from 8gent's own codebase:

| Metric | Traditional | AST-First | Savings |
|--------|-------------|-----------|---------|
| Average file read | 1,027 tokens | 546 tokens | **46.8%** |
| Symbol retrieval | 2,119 tokens | 61 tokens | **97.1%** |
| 10K operations (Claude Opus) | $3,084 | $1,640 | **$1,444 saved** |

Run `8gent benchmark` to see results on your codebase.

---

## Quick Start

```bash
# Clone and install
git clone https://github.com/8gent/8gent-code.git
cd 8gent-code
bun install

# Make sure Ollama is running with a model
ollama pull glm4:latest  # or any capable model

# Start interactive agent
bun run packages/agent/index.ts

# Or run a task directly
bun run packages/agent/index.ts "Create a React component with TypeScript"
```

### AST-First Tools (Token Savings)

```bash
# Get file outline (symbols, functions, classes)
bun run bin/8gent.ts outline src/index.ts

# Get specific symbol source
bun run bin/8gent.ts symbol src/utils.ts::parseDate

# Search across codebase
bun run bin/8gent.ts search "handleError" --kinds=function
```

---

## The Name

**8gent** combines two ideas:

- **8** → infinity (∞ rotated)
- **gent** → gentleman / agent

An **infinite agent**: a disciplined system that grows without increasing prompt size.

---

## Philosophy

Most coding agents navigate codebases like this:

```
search → read → guess → patch
```

8gent works differently:

```
plan → retrieve → compose → verify
```

**Structure replaces brute-force exploration.**

---

## Architecture

```
User Intent
    ↓
8gent CLI / TUI
    ↓
Planner (task decomposition)
    ↓
Toolshed (capability discovery)
    ↓
AST Index (symbol extraction)
    ↓
Codebase
```

### Core Packages

| Package | Purpose |
|---------|---------|
| `ast-index` | TypeScript Compiler API for native TS/JS parsing |
| `planner` | Task planning with dependency tracking |
| `toolshed` | Dynamic tool registration and discovery |
| `types` | Shared TypeScript definitions |

---

## Toolshed

The Toolshed is the capability layer. Tools register themselves and are discovered dynamically.

```typescript
registerTool({
  name: "get_outline",
  description: "Get all symbols in a file without loading full content",
  capabilities: ["code", "code.symbol"],
  permissions: ["read:code"],
}, async (input, context) => {
  // AST-first implementation
});
```

Available tools:
- `get_outline` - File symbol extraction
- `get_symbol` - Single symbol retrieval
- `search_symbols` - Cross-file symbol search

---

## Project Structure

```
📂 8gent-code
├── bin/
│   └── 8gent.ts           # CLI entry point
├── apps/
│   └── tui/               # Terminal UI (Ink/React)
├── packages/
│   ├── ast-index/         # AST parsing (TS Compiler API)
│   ├── planner/           # Task planning engine
│   ├── toolshed/          # Tool registry and discovery
│   ├── types/             # Shared TypeScript types
│   └── workflow/          # Workflow execution
└── scripts/
    ├── benchmark.ts       # Full benchmark suite
    └── demo-savings.ts    # Token savings demo
```

---

## Commands

```bash
8gent init              # Initialize in current directory
8gent outline <file>    # Get symbol outline
8gent symbol <id>       # Get symbol source code
8gent search <query>    # Search for symbols
8gent benchmark         # Run efficiency benchmarks
8gent demo              # Show token savings demo
```

---

## Roadmap: Closing the Gap with Claude Code

8gent matches Claude Code on basic coding tasks. Here's what's coming:

| Feature | Claude Code | 8gent | Status |
|---------|-------------|-------|--------|
| File read/write/edit | Yes | Yes | Done |
| Git operations | Yes | Yes | Done |
| Shell commands | Yes | Yes | Done |
| BMAD planning method | No | Yes | Done |
| Slash commands | Yes | Yes | Done |
| MCP (Model Context Protocol) | Yes | No | Planned |
| Web search / WebFetch | Yes | No | Planned |
| Parallel tool calls | Yes | No | Planned |
| LSP integration | Yes | No | Planned |
| Image/PDF reading | Yes | No | Planned |
| Notebook editing | Yes | No | Planned |
| Background tasks | Yes | No | Planned |
| Permission system | Yes | No | Planned |
| Hooks system | Yes | No | Planned |
| Skills/Skill invocation | Yes | No | Planned |
| Multi-agent orchestration | Yes | No | Planned |

**Contributing?** Pick a feature from the roadmap and open a PR!

---

## Acknowledgments

The AST-first approach was influenced by [jcodemunch](https://github.com/jgravelle/jcodemunch-mcp), which demonstrated the power of symbol-level code retrieval for reducing token consumption. 8gent builds on this foundation with a complete toolshed architecture.

---

## Contributing

1. Fork the repo
2. Create your feature branch (`git checkout -b feature/amazing`)
3. Run benchmarks to verify savings (`bun run benchmark`)
4. Commit your changes
5. Push to the branch
6. Open a Pull Request

---

## License

MIT © 8GI Foundation

---

<p align="center">
  <strong>Stop paying for tokens you don't need.</strong><br>
  <a href="https://github.com/8gent/8gent-code">⭐ Star us on GitHub</a>
</p>
