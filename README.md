# 8gent Code

A terminal-first development environment designed for structured agentic software creation.

Instead of relying on brute-force repository search, 8gent operates through **structured retrieval**, **composable primitives**, and an **extensible toolshed architecture**.

The goal is simple: **build more software with less context and less guesswork.**

---

## The Name

**8gent** combines two ideas:

- **8** → infinity (∞ rotated)
- **gent** → gentleman / agent

The result is an **infinite agent**: a disciplined system capable of continuously expanding its capabilities.

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

## Core Ideas

8gent Code is built around four principles:

### 1. Structured Planning

Tasks are executed through deterministic workflows inspired by modern AI development frameworks.

### 2. AST-first Code Navigation

Instead of scanning files, the system retrieves symbols directly and edits them precisely.

### 3. Primitive Composition

Software is assembled from reusable primitives:

- UI components
- Animation primitives
- Workflow templates
- Mini-app schemas

### 4. Toolshed Architecture

Capabilities live outside the model in a centralized tool registry.

This allows the system to grow indefinitely **without increasing prompt size**.

---

## Toolshed

The toolshed is the capability layer of 8gent.

```
agent
  ↓
toolshed
  ↓
tools
```

Instead of loading tools into the prompt, the agent **discovers them dynamically**.

Capabilities include:

- Code tools (AST query, symbol edit, patch)
- Design primitives (components, animations)
- Workflow engines
- Repo tools (dependency graphs)
- GitHub intelligence (symbol search across open source)
- Execution environments (sandboxed runners)

New capabilities are added by registering new tools.

---

## Retrieval Strategy

8gent uses a strict hierarchy:

1. **Registry lookup** - Check if primitive exists
2. **AST symbol retrieval** - Get exact symbol by path
3. **Semantic verification** - LSP for type checking
4. **Fallback search** - grep/glob only when necessary

This keeps context small and edits precise.

---

## Architecture

```
User Intent
    ↓
8gent TUI
    ↓
Planner
    ↓
Workflow Engine
    ↓
Toolshed
    ↓
Execution Sandbox
    ↓
Codebase / Internet
```

---

## GitHub Intelligence

8gent can query indexed open source repositories.

Instead of scraping GitHub like a website, the system treats it as a **structured code database**:

- Symbol search across repos
- Dependency graphs
- Usage patterns

This allows the agent to integrate modern libraries with minimal prompting.

---

## Project Structure

```
📂 8gent-code
├── README.md
├── apps/
│   └── tui/              # Terminal UI application
├── packages/
│   ├── planner/          # Task planning engine
│   ├── workflow/         # Workflow execution
│   ├── registry/         # Primitive registry
│   ├── ast-index/        # AST parsing and indexing
│   ├── toolshed/         # Tool discovery and execution
│   └── types/            # Shared TypeScript types
└── docs/                 # Architecture documentation
```

---

## Acknowledgments

The AST-first approach was influenced by [jcodemunch](https://github.com/jgravelle/jcodemunch-mcp), which demonstrated the power of symbol-level code retrieval for reducing token consumption. 8gent builds on this foundation with a complete toolshed architecture.

---

## Status

Early architecture. Actively evolving.

---

## License

MIT
