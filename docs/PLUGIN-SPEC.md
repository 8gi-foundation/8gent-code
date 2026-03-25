# Eight Plugin System Specification

Version: 0.1.0 (Draft)
Status: Quarantine - design phase

## Overview

The Eight plugin system lets third parties extend Eight's capabilities without modifying core code. Plugins are self-contained packages that register hooks, tools, themes, benchmarks, or personas through a standard manifest and lifecycle.

**Core principle:** Plugins run in a restricted sandbox. They cannot access the host filesystem arbitrarily, cannot modify core agent behavior, and cannot exfiltrate data. Security is deny-by-default.

## Plugin Types

| Type | What it adds | Example |
|------|-------------|---------|
| **tool** | New tool callable by the agent | A Jira integration, a Slack poster, a SQL query tool |
| **benchmark** | New benchmark category for autoresearch | Domain-specific eval (e.g., medical QA, legal reasoning) |
| **theme** | TUI color/typography theme | Solarized, Dracula, corporate brand themes |
| **persona** | Agent personality overlay | Formal assistant, pair programmer, tutor |

A single plugin can provide multiple types (e.g., a "Jira plugin" could provide a tool and a persona).

## Plugin Manifest

Plugins are npm-compatible packages. The manifest lives in `package.json` with an `"eight"` field:

```json
{
  "name": "eight-plugin-jira",
  "version": "1.0.0",
  "description": "Jira integration for Eight",
  "main": "dist/index.js",
  "eight": {
    "type": ["tool"],
    "apiVersion": "1",
    "displayName": "Jira Integration",
    "permissions": ["network:*.atlassian.net", "env:JIRA_*"],
    "entry": "dist/index.js",
    "config": {
      "baseUrl": {
        "type": "string",
        "required": true,
        "description": "Your Jira instance URL"
      }
    }
  },
  "keywords": ["eight-plugin"],
  "license": "MIT"
}
```

### Manifest Fields

| Field | Required | Description |
|-------|----------|-------------|
| `eight.type` | Yes | Array of plugin types: `"tool"`, `"benchmark"`, `"theme"`, `"persona"` |
| `eight.apiVersion` | Yes | Plugin API version. Currently `"1"`. |
| `eight.displayName` | Yes | Human-readable name shown in plugin list |
| `eight.permissions` | Yes | Explicit list of capabilities the plugin requests (see Security) |
| `eight.entry` | No | Entry point. Defaults to `"main"` from package.json |
| `eight.config` | No | Plugin-specific configuration schema |
| `eight.minEightVersion` | No | Minimum Eight version required (SemVer) |

## Plugin Lifecycle

### 1. Install

```bash
eight plugin install eight-plugin-jira
# or from GitHub
eight plugin install github:user/eight-plugin-jira
# or local
eight plugin install ./my-plugin
```

Plugins are installed to `.8gent/plugins/<plugin-name>/`. The installer:
- Downloads/copies the package
- Validates the manifest (must have `eight` field, valid `apiVersion`)
- Checks permission declarations against the user's policy
- Stores metadata in `.8gent/plugins/registry.json`

### 2. Register

On install, the plugin is registered but **inactive** by default. Registration records:
- Plugin name, version, types
- Declared permissions
- Entry point path
- Installation timestamp

### 3. Activate

```bash
eight plugin activate eight-plugin-jira
```

Activation:
- Loads the plugin entry point in a sandboxed context
- Calls the plugin's `activate(context)` function
- Registers any tools, themes, personas, or benchmarks with Eight's runtime
- Plugin receives a restricted `PluginContext` object (see API below)

### 4. Deactivate

```bash
eight plugin deactivate eight-plugin-jira
```

Deactivation:
- Calls the plugin's `deactivate()` function (cleanup hook)
- Unregisters all tools/themes/personas/benchmarks
- Plugin state is preserved in `.8gent/plugins/<name>/state.json` for reactivation

### 5. Uninstall

```bash
eight plugin uninstall eight-plugin-jira
```

Removes plugin directory and registry entry. Calls `deactivate()` first if active.

## Plugin API

Every plugin must export a default object conforming to `EightPlugin`:

```typescript
import type { EightPlugin, PluginContext } from "@8gent/plugin-api";

const plugin: EightPlugin = {
  name: "eight-plugin-jira",
  version: "1.0.0",

  async activate(ctx: PluginContext) {
    // Register a tool
    ctx.registerTool({
      name: "jira_create_issue",
      description: "Create a Jira issue",
      parameters: {
        project: { type: "string", required: true },
        summary: { type: "string", required: true },
        description: { type: "string" },
      },
      execute: async (params) => {
        const resp = await ctx.fetch(`${ctx.config.baseUrl}/rest/api/3/issue`, {
          method: "POST",
          headers: { Authorization: `Bearer ${ctx.env("JIRA_TOKEN")}` },
          body: JSON.stringify({ fields: params }),
        });
        return resp.json();
      },
    });
  },

  async deactivate() {
    // Cleanup resources
  },
};

export default plugin;
```

### PluginContext

The context object passed to `activate()`. All host access goes through this interface - plugins never import Node/Bun globals directly.

| Method | Description |
|--------|-------------|
| `registerTool(def)` | Register a tool the agent can call |
| `registerBenchmark(def)` | Register a benchmark category |
| `registerTheme(def)` | Register a TUI theme |
| `registerPersona(def)` | Register a persona overlay |
| `fetch(url, opts)` | Sandboxed fetch - only allowed domains per manifest |
| `env(name)` | Read an env var - only allowed patterns per manifest |
| `readFile(path)` | Read a file - only within plugin's own directory |
| `writeFile(path, data)` | Write a file - only within plugin's state directory |
| `config` | Plugin config values set by the user |
| `log(level, msg)` | Structured logging to Eight's log system |
| `getMemory(query)` | Read-only semantic search of Eight's memory (if permitted) |

## Security Sandboxing

### Deny-by-default

Plugins have **zero** capabilities unless explicitly declared in `permissions` and approved by the user.

### Permission Types

| Permission | Format | Example | What it grants |
|-----------|--------|---------|----------------|
| Network | `network:<glob>` | `network:*.atlassian.net` | HTTP requests to matching domains |
| Environment | `env:<glob>` | `env:JIRA_*` | Read matching env vars |
| Filesystem | `fs:read` or `fs:write` | `fs:read` | Read/write within plugin directory only |
| Memory | `memory:read` | `memory:read` | Read-only access to Eight's memory store |
| Shell | `shell:<command>` | `shell:git` | Execute specific commands (highly restricted) |

### What Plugins Cannot Do

- Access files outside `.8gent/plugins/<plugin-name>/`
- Execute arbitrary shell commands
- Modify Eight's core configuration
- Access other plugins' state
- Make network requests to undeclared domains
- Read environment variables not in their permission list
- Intercept or modify the agent's conversation
- Bypass the policy engine
- Access the training pipeline or kernel
- Run in the background after deactivation

### Approval Flow

1. On install, Eight displays the plugin's requested permissions
2. User must explicitly approve each permission category
3. Approved permissions are stored in `.8gent/plugins/registry.json`
4. Permissions can be revoked at any time via `eight plugin permissions <name>`

### Sandboxing Implementation

Plugins run in an isolated module context. The loader:
- Wraps the plugin in a function scope with no access to `process`, `fs`, `child_process`, or `Bun.spawn`
- Provides only the `PluginContext` proxy object
- All I/O goes through context methods that enforce permission checks
- Network requests are proxied through a domain allowlist filter
- File operations are path-jailed to the plugin's directory

## Distribution

### npm

The standard distribution channel. Plugins use the `eight-plugin-` prefix by convention:

```bash
npm publish  # publishes eight-plugin-jira
eight plugin install eight-plugin-jira  # resolves via npm
```

### GitHub

Direct installation from a GitHub repository:

```bash
eight plugin install github:user/eight-plugin-jira
eight plugin install github:user/eight-plugin-jira@v1.2.0  # pinned version
```

### Local

For development or private plugins:

```bash
eight plugin install ./path/to/my-plugin
eight plugin install file:../my-plugin
```

### 8gent Marketplace (Future)

A curated registry at `plugins.8gent.dev` with:
- Verified plugins (code-reviewed, security-audited)
- Community ratings and install counts
- Compatibility badges (tested Eight versions)
- One-click install from the TUI

This is not built yet. npm and GitHub are the initial channels.

## Plugin Configuration

Users configure plugins via `.8gent/config.json`:

```json
{
  "plugins": {
    "eight-plugin-jira": {
      "enabled": true,
      "config": {
        "baseUrl": "https://myteam.atlassian.net"
      }
    }
  }
}
```

Or via CLI:

```bash
eight plugin config eight-plugin-jira baseUrl https://myteam.atlassian.net
```

## Plugin Registry Format

`.8gent/plugins/registry.json`:

```json
{
  "version": 1,
  "plugins": {
    "eight-plugin-jira": {
      "version": "1.0.0",
      "types": ["tool"],
      "active": true,
      "installedAt": "2026-03-25T10:00:00Z",
      "permissions": {
        "network": ["*.atlassian.net"],
        "env": ["JIRA_*"]
      },
      "entry": ".8gent/plugins/eight-plugin-jira/dist/index.js"
    }
  }
}
```

## CLI Reference

| Command | Description |
|---------|-------------|
| `eight plugin list` | List installed plugins with status |
| `eight plugin install <source>` | Install a plugin |
| `eight plugin uninstall <name>` | Remove a plugin |
| `eight plugin activate <name>` | Enable a plugin |
| `eight plugin deactivate <name>` | Disable a plugin |
| `eight plugin config <name> [key] [value]` | View or set plugin config |
| `eight plugin permissions <name>` | View or modify granted permissions |
| `eight plugin info <name>` | Show plugin details and health |

## Open Questions

- Should plugins be able to declare dependencies on other plugins?
- Should there be a "plugin dev mode" with hot reload?
- What is the versioning contract for the plugin API itself?
- Should benchmark plugins be able to write to the autoresearch loop state?
- Rate limiting for plugin network requests - per-plugin or global?
