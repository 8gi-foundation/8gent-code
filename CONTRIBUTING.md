# Contributing to 8gent Code

Thank you for your interest in contributing to 8gent Code!

## Philosophy

8gent Code is built on a simple principle: **structure beats brute-force**.

Instead of reading entire files and searching through codebases, we use:
- AST-first symbol retrieval
- Composable primitives
- Dynamic tool discovery via the Toolshed

## Getting Started

```bash
# Clone the repo
git clone https://github.com/jamesspalding/8gent-code.git
cd 8gent-code

# Install dependencies (requires Bun)
bun install

# Run the TUI
bun run dev
```

## Project Structure

```
8gent-code/
├── apps/tui/           # Terminal UI (Ink/React)
├── packages/
│   ├── types/          # Shared TypeScript types
│   ├── ast-index/      # AST parsing and symbol extraction
│   ├── toolshed/       # Tool registry and discovery
│   ├── registry/       # Primitive database (SQLite)
│   ├── planner/        # Task planning engine
│   └── workflow/       # Workflow execution
└── docs/               # Architecture documentation
```

## How to Contribute

### 1. Add a New Tool

Tools live in `packages/toolshed/tools/`. Each tool:
- Registers itself with the toolshed
- Declares its capabilities and permissions
- Executes in a sandboxed environment

```typescript
import { registerTool } from "../registry/register";

registerTool({
  name: "my_tool",
  description: "What it does",
  capabilities: ["code"],
  inputSchema: { type: "object", properties: {} },
  permissions: ["read:code"],
}, async (input, context) => {
  // Implementation
});
```

### 2. Add a Primitive

Primitives are reusable patterns stored in SQLite. Add them via:

```typescript
import { addPrimitive } from "@8gent/registry";

addPrimitive({
  id: "button-primary",
  type: "component",
  name: "Primary Button",
  source: "...",
  tags: ["ui", "button", "primary"],
});
```

### 3. Improve AST Parsing

The AST index lives in `packages/ast-index/`. We use:
- TypeScript Compiler API for TS/JS
- tree-sitter for other languages

### 4. Enhance the TUI

The terminal UI uses Ink (React for CLI). Components are in `apps/tui/src/components/`.

## Code Style

- TypeScript strict mode
- Biome for linting/formatting
- Meaningful variable names
- Document public APIs

## Testing

```bash
bun test
```

## Pull Request Process

1. Fork the repo
2. Create a feature branch
3. Make your changes
4. Run tests
5. Submit a PR

## Questions?

Open an issue or reach out on X: [@jamesspalding](https://x.com/jamesspalding)
