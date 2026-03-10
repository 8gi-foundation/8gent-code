# Toolshed Architecture

The toolshed is the capability layer of 8gent. Inspired by Stripe's agent architecture, it ensures the agent never carries knowledge or tools inside its prompt.

## Why Toolshed?

**Without a toolshed:**
- Agent prompt grows forever
- Every new capability = more tokens
- System becomes slow and expensive

**With a toolshed:**
- Agent prompt stays small
- Tools scale infinitely
- Capabilities are discovered, not loaded

---

## Architecture

```
User
  ↓
8gent CLI / TUI
  ↓
Planner
  ↓
Workflow Engine
  ↓
TOOLSHED
  ↓
Execution Sandbox
  ↓
Codebase / Internet
```

---

## Four Responsibilities

### 1. Tool Registry

All tools register themselves:

```typescript
register_tool({
  name: "get_symbol",
  description: "Retrieve a symbol by its AST path",
  input_schema: {
    repo: "string",
    symbol_id: "string"
  },
  permissions: ["read:code"]
})
```

The agent never loads every tool into context. Instead it queries:

```typescript
list_tools(capability: "code")
```

### 2. Capability Discovery

Tools are grouped by capability:

| Capability | Description |
|------------|-------------|
| `code` | AST query, symbol edit, patch |
| `code.symbol` | Symbol-specific operations |
| `design` | UI components, animations |
| `workflow` | Task automation |
| `repo` | Dependency graphs, file tree |
| `github` | Open source intelligence |
| `execution` | Test runners, builds |

Example query:

```typescript
toolshed.query(capability: "code.symbol")
// Returns: get_symbol, edit_symbol, patch_symbol, trace_refs
```

### 3. Execution Isolation

Tools run in sandbox environments.

This protects:
- Filesystem
- Secrets
- Repos
- Runtime

Implementation options:
- Container sandbox (Docker)
- Local runtime jail (Deno-style permissions)
- Firecracker microVMs (future)

### 4. Skill Accumulation

Every new skill is just another tool. The system evolves:

**v1 toolshed:**
```
grep, read_file, write_file
```

**v2:**
```
ast_query, symbol_edit, patch_symbol
```

**v3:**
```
component_lookup, animation_lookup, workflow_lookup
```

**v4:**
```
github_symbol_search, repo_dependency_graph
```

The agent becomes more capable without increasing prompt size.

---

## Directory Structure

```
📂 toolshed/
├── registry/
│   ├── register.ts      # Tool registration
│   └── discovery.ts     # Capability queries
│
├── tools/
│   ├── code/
│   │   ├── ast-query.ts
│   │   ├── edit-symbol.ts
│   │   └── patch.ts
│   │
│   ├── design/
│   │   ├── get-component.ts
│   │   └── get-animation.ts
│   │
│   ├── repo/
│   │   └── dependency-graph.ts
│   │
│   ├── github/
│   │   ├── search-symbol.ts
│   │   └── repo-index.ts
│   │
│   └── execution/
│       ├── run-tests.ts
│       └── run-build.ts
│
├── sandbox/
│   ├── container.ts
│   └── runtime.ts
│
└── permissions/
    └── policy.ts
```

---

## Tool Lifecycle

```
tool created
    ↓
registered with toolshed
    ↓
discoverable by capability
    ↓
agent calls tool
    ↓
tool executes in sandbox
    ↓
result returned
```

---

## Tool Schema

Every tool follows this interface:

```typescript
interface Tool {
  name: string;
  description: string;
  capability: string[];
  input_schema: JSONSchema;
  output_schema: JSONSchema;
  permissions: Permission[];
  execute: (input: unknown) => Promise<unknown>;
}
```

---

## Permission Model

Tools declare required permissions:

```typescript
type Permission =
  | "read:code"      // Read source files
  | "write:code"     // Modify source files
  | "read:fs"        // Read filesystem
  | "write:fs"       // Write filesystem
  | "exec:shell"     // Execute shell commands
  | "net:fetch"      // Make HTTP requests
  | "net:listen"     // Open ports
  | "github:read"    // Read GitHub data
  | "github:write"   // Write to GitHub
```

The sandbox enforces these at runtime.

---

## GitHub Intelligence Layer

Treat GitHub as a structured code database:

```
GitHub Index
├── AST symbol map
├── Dependency graphs
└── Usage patterns
```

Tool example:

```typescript
query_github_symbols({
  query: "useQuery",
  language: "typescript",
  min_stars: 1000
})
```

From the user's perspective: "the agent knows every library"

Reality: structured retrieval.
