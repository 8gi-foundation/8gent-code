# Contributing to 8gent Code

Thank you for your interest in contributing to 8gent Code — The Infinite Gentleman!

## Philosophy

8gent is built on a simple principle: **structure beats brute-force**.

Instead of reading entire files and searching through codebases, we use:
- AST-first symbol retrieval (97% token savings)
- Proactive planning via BMAD method
- Multi-agent orchestration for complex tasks
- Evidence-based validation

## Getting Started

```bash
# Clone the repo
git clone https://github.com/PodJamz/8gent-code.git
cd 8gent-code

# Install dependencies (requires Bun)
bun install

# Make sure Ollama is running
ollama pull glm-4.7-flash:latest

# Run the agent
bun run packages/agent/index.ts
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

### 4. Add a Skill

Skills extend agent capabilities. Add to `packages/skills/`:

```typescript
registerSkill({
  name: "my-skill",
  description: "What it does",
  execute: async (context) => {
    // Implementation
  }
});
```

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
