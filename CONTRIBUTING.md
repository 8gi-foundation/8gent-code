# Contributing to 8gent Code

Thank you for your interest in contributing to 8gent Code — The Infinite Gentleman!

## Philosophy

8gent is built on a simple principle: **structure beats brute-force**.

Instead of reading entire files and searching through codebases, we use:
- **AST-first symbol retrieval** — `indexFolder()` parses TS/JS files into symbol maps; `getSymbolSource()` extracts specific symbols (97% token savings)
- **BMAD universal planning** — classifies tasks (Code, Creative, Research, Planning, Communication) and adapts approach; proactive planner tracks momentum and predicts next steps
- **Multi-agent orchestration** — spawn background agents, kanban board, agent pool management
- **Evidence-based validation** — EvidenceCollector fires after file writes, commands, and git commits; session-level evidence summary

## Getting Started

### Users

```bash
npm install -g @podjamz/8gent-code
8gent
```

### Contributors (from source)

```bash
git clone https://github.com/8gi-foundation/8gent-code.git
cd 8gent-code
bun install
bun run tui
```

## Project Structure

```
8gent-code/
├── bin/
│   └── 8gent-cli.sh           # Global CLI entry point
├── apps/
│   └── tui/                   # Terminal UI (Ink/React)
│       └── src/
│           ├── components/    # UI components
│           └── hooks/         # React hooks
├── packages/
│   ├── agent/                 # Main agent loop
│   ├── ast-index/             # AST parsing (TS Compiler API)
│   ├── hooks/                 # Hook system
│   ├── lsp/                   # LSP client
│   ├── mcp/                   # MCP client
│   ├── orchestration/         # Multi-agent coordination
│   ├── permissions/           # Permission manager
│   ├── personality/           # Brand voice and status verbs
│   ├── planning/              # Proactive planner
│   ├── planner/               # Task decomposition
│   ├── reporting/             # Completion reports
│   ├── skills/                # Skill framework
│   ├── tasks/                 # Task management
│   ├── tools/                 # Web, PDF, image, notebook tools
│   ├── toolshed/              # Tool registry and discovery
│   ├── types/                 # Shared TypeScript types
│   ├── validation/            # Evidence collection
│   └── workflow/              # Workflow execution
├── docs/                      # Documentation
│   ├── hooks.md
│   ├── permissions.md
│   └── TOOLSHED.md
└── scripts/
    ├── benchmark.ts           # Benchmark suite
    └── demo-savings.ts        # Token savings demo
```

## How to Contribute

### 1. Add a New Tool

Tools live in `packages/tools/`. Each tool should:
- Export clear async functions
- Handle errors gracefully
- Return structured data

```typescript
// packages/tools/my-tool.ts
export async function myTool(input: string): Promise<MyResult> {
  // Implementation
}
```

### 2. Add a TUI Component

TUI components use Ink (React for CLI). Add them to `apps/tui/src/components/`:

```tsx
import React from "react";
import { Box, Text } from "ink";

export function MyComponent({ data }: Props) {
  return (
    <Box>
      <Text color="green">{data}</Text>
    </Box>
  );
}
```

### 3. Add a Hook Type

Hooks are in `packages/hooks/`. Register new types:

```typescript
export type HookType =
  | "beforeTool"
  | "afterTool"
  | "onComplete"
  | "myNewHook";  // Add here
```

### 4. Propose a Bundled Skill

Skills extend agent capabilities. They are markdown files with YAML frontmatter, loaded by `packages/skills/index.ts`. The directory structure is:

```
packages/skills/<slug>/SKILL.md
```

Example frontmatter:

```yaml
---
name: my-skill
description: One sentence. What it does and when to use it.
trigger: /my-skill
aliases: [/my, /ms]
tools: [bash, read]
---
```

See `packages/skills/README.md` for the full format reference and the current bundled inventory.

#### Proposal process

Bundled skills ship to every user on install. That raises the bar.

1. Open a GitHub issue titled `skill-proposal: <slug>`. Describe the problem it solves, who benefits, and why it belongs in the default set rather than a user's personal config.
2. Draft the `SKILL.md` in a feature branch and open a PR that references the proposal issue.
3. An 8SO (Karen, security officer) sign-off is required before merge. Every bundled skill is treated as code we distribute, so it must pass the same security review: no prompt-injection patterns, no jailbreak-adjacent instructions, no data-exfiltration defaults, no dependencies that require paid API keys to be useful on install.
4. Maintainers review for generality. Skills that reference specific people, companies, private repos, or maintainer-only workflows belong in the author's own `~/.8gent/skills/`, not in the bundle.

#### Hard content rules for bundled skills

- Generic only. No named contacts, no proprietary project references, no opinions about specific companies.
- No em dashes. Use hyphens, colons, commas, or parentheses.
- No AI vendor or model names in examples. Describe the agent behavior instead.
- No emojis in code. User-facing output may include them where appropriate.
- Keep it focused. One clear job per skill, roughly 30 to 120 lines of markdown.

#### What gets rejected

- Jailbreak, god-mode, or prompt-injection skills.
- Skills that require cloud-only paid services to do anything useful out of the box.
- Duplicates of existing bundled skills without a clear upgrade path.
- Skills that are really personal automations dressed up as generic tools.

### 5. Improve AST Parsing

The AST index lives in `packages/ast-index/`. We use:
- TypeScript Compiler API for TS/JS
- tree-sitter for other languages (Python, Rust, Go, Java)

### 6. Add Personality

The Infinite Gentleman's voice is in `packages/personality/`:
- `status-verbs.ts` — Animated status messages
- `voice.ts` — Brand voice and tone
- `brand.ts` — Identity and taglines

## Code Style

- TypeScript strict mode
- Biome for linting/formatting (`bun run lint`)
- Meaningful variable names
- Document public APIs
- No emojis in code (reserve for user-facing output)

## Testing

```bash
bun test
```

## Benchmarks

Before submitting, verify token savings:

```bash
bun run benchmark
```

## Pull Request Process

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/amazing`)
3. Make your changes
4. Run tests and benchmarks
5. Commit with clear messages
6. Submit a PR

## Documentation

When adding features, update relevant docs:
- `README.md` — User-facing features
- `docs/*.md` — Technical documentation
- Inline JSDoc comments for APIs

## Questions?

Open an issue or reach out on X: [@james__spalding](https://x.com/james__spalding)

---

**The Infinite Gentleman appreciates your contribution.**
