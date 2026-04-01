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

## Architecture (v0.2.0)

```
User
  ↓
8gent CLI / TUI
  ↓
Proactive Planner (BMAD)
  ↓
Multi-Agent Orchestration
  ↓
TOOLSHED
  ↓
┌────────────────────────────────────────────────────┐
│  MCP  │  LSP  │  Web  │  Shell  │  AST  │  FS    │
│  PDF  │  Image │ Notebook │ Background │ Skills │
└────────────────────────────────────────────────────┘
  ↓
Evidence Collection & Validation
  ↓
Completion Report
```

---

## Tool Categories

### Core Tools

| Tool | Package | Description |
|------|---------|-------------|
| `read_file` | agent | Read file contents |
| `write_file` | agent | Write file contents |
| `edit_file` | agent | Edit file with find/replace |
| `list_files` | agent | List directory contents |
| `execute_command` | agent | Run shell commands |
| `search_files` | agent | Glob/grep file search |

### AST Tools

| Tool | Package | Description |
|------|---------|-------------|
| `get_outline` | ast-index | File symbol extraction |
| `get_symbol` | ast-index | Single symbol retrieval |
| `search_symbols` | ast-index | Cross-file symbol search |

### MCP Tools

| Tool | Package | Description |
|------|---------|-------------|
| `mcp_connect` | mcp | Connect to MCP server |
| `mcp_call` | mcp | Call MCP tool |
| `mcp_list` | mcp | List MCP capabilities |

### LSP Tools

| Tool | Package | Description |
|------|---------|-------------|
| `lsp_definition` | lsp | Go to definition |
| `lsp_references` | lsp | Find references |
| `lsp_hover` | lsp | Get hover info |
| `lsp_completion` | lsp | Get completions |
| `lsp_diagnostics` | lsp | Get diagnostics |

### Web Tools

| Tool | Package | Description |
|------|---------|-------------|
| `web_search` | tools/web | Search the web |
| `web_fetch` | tools/web | Fetch URL content |
| `extract_content` | tools/web | Extract readable content |

### Media Tools

| Tool | Package | Description |
|------|---------|-------------|
| `read_image` | tools/image | Read and describe images |
| `read_pdf` | tools/pdf | Extract PDF text |
| `search_pdf` | tools/pdf | Search within PDFs |

### Notebook Tools

| Tool | Package | Description |
|------|---------|-------------|
| `read_notebook` | tools/notebook | Read Jupyter notebook |
| `edit_cell` | tools/notebook | Edit notebook cell |
| `run_cell` | tools/notebook | Execute notebook cell |

### Background Tools

| Tool | Package | Description |
|------|---------|-------------|
| `run_background` | tools/background | Run command in background |
| `check_background` | tools/background | Check background task status |
| `kill_background` | tools/background | Stop background task |

---

## Capability Discovery

Tools are grouped by capability:

| Capability | Description |
|------------|-------------|
| `code` | AST query, symbol edit, patch |
| `code.symbol` | Symbol-specific operations |
| `web` | Web search, URL fetch |
| `media` | Image, PDF, notebook |
| `mcp` | External tool integration |
| `lsp` | Code intelligence |
| `execution` | Shell, background tasks |
| `repo` | Dependency graphs, file tree |

Example query:

```typescript
toolshed.query(capability: "code.symbol")
// Returns: get_outline, get_symbol, search_symbols
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
  | "mcp:connect"    // Connect to MCP servers
  | "lsp:connect"    // Connect to LSP servers
```

---

## Tool Registration

All tools register themselves:

```typescript
register_tool({
  name: "get_symbol",
  description: "Retrieve a symbol by its AST path",
  input_schema: {
    repo: "string",
    symbol_id: "string"
  },
  permissions: ["read:code"],
  execute: async (input) => {
    // Implementation
  }
});
```

The agent never loads every tool into context. Instead it queries by capability.

---

## Multi-Agent Integration

The toolshed supports parallel tool execution:

```typescript
// Execute tools in parallel
const results = await Promise.all([
  toolshed.execute("read_file", { path: "a.ts" }),
  toolshed.execute("read_file", { path: "b.ts" }),
  toolshed.execute("web_search", { query: "react hooks" })
]);
```

---

## Skill Accumulation

Every new skill is just another tool. The system evolves:

**v1:**
```
grep, read_file, write_file
```

**v2:**
```
ast_query, symbol_edit, patch_symbol
```

**v3 (current):**
```
mcp_connect, lsp_definition, web_search,
read_pdf, read_image, run_background
```

The agent becomes more capable without increasing prompt size.

---

## Evidence Collection

Tools integrate with the validation system:

```typescript
const result = await toolshed.execute("read_file", { path });

evidenceCollector.addEvidence({
  type: "file_read",
  source: path,
  content: result,
  verified: true
});
```

---

## Directory Structure

```
📂 packages/
├── toolshed/
│   ├── index.ts            # Main registry
│   └── discovery.ts        # Capability queries
├── tools/
│   ├── web.ts              # Web search/fetch
│   ├── pdf.ts              # PDF extraction
│   ├── image.ts            # Image reading
│   ├── notebook.ts         # Jupyter notebooks
│   └── background.ts       # Background tasks
├── mcp/
│   └── index.ts            # MCP client
├── lsp/
│   └── index.ts            # LSP client
└── ast-index/
    └── index.ts            # AST extraction
```
