# Extension System Spec

> Issue #937 - Plugin/extension system for third-party tool registration

## Problem

Eight's tool set is hardcoded. Users cannot add custom tools, integrations, or workflows without forking the repo. We need a plugin system that lets anyone extend Eight safely.

## Constraint

Extensions must be sandboxed via NemoClaw policy engine. No extension can execute arbitrary code without user-approved permissions. Must work with both Bun and jiti for loading.

## Not doing

- Extension marketplace or registry (LATER)
- Remote extension loading from URLs (security risk)
- Extension auto-updates
- GUI for extension management (CLI only for now)

## Success metric

A user can install a third-party extension from a local directory or npm package, and it registers custom tools available in the agent loop within 30 seconds.

---

## 1. Extension Manifest

Each extension has an `8gent-extension.json` manifest at its root:

```typescript
interface ExtensionManifest {
  name: string;               // unique identifier, e.g. "8gent-docker"
  version: string;            // semver
  description: string;
  author: string;
  entry: string;              // relative path to main module
  permissions: string[];      // NemoClaw permission labels, e.g. ["fs:read", "net:localhost"]
  tools?: ToolDefinition[];   // static tool declarations (optional, can register dynamically)
  hooks?: {
    onSessionStart?: string;  // exported function name
    onSessionEnd?: string;
    onToolCall?: string;      // intercept/augment tool calls
    onMessage?: string;       // pre/post message processing
  };
  engines?: {
    eight?: string;           // semver range, e.g. ">=1.5.0"
  };
}
```

---

## 2. Lifecycle

1. **Install** - `8gent ext install <path|npm-package>` copies/links to `~/.8gent/extensions/<name>/`
2. **Validate** - manifest parsed, permissions checked against NemoClaw policy
3. **Load** - `jiti` (for CJS compat) or native Bun import for `.ts` files
4. **Register** - tools added to agent tool set, hooks wired into event bus
5. **Unload** - `8gent ext remove <name>` unhooks and deletes

```typescript
interface ExtensionRuntime {
  name: string;
  manifest: ExtensionManifest;
  module: Record<string, Function>;
  status: "loaded" | "disabled" | "error";
  sandbox: NemoClawSandbox;
}
```

---

## 3. Sandboxing

Each extension runs within a NemoClaw sandbox scoped to its declared permissions:

- `fs:read` / `fs:write` - filesystem access (scoped to project dir by default)
- `net:localhost` / `net:external` - network access
- `exec:shell` - subprocess spawning (requires explicit user approval)
- `memory:read` / `memory:write` - access to memory store

Undeclared permissions are denied. User sees a confirmation prompt on first load listing requested permissions.

---

## 4. CLI Commands

```
8gent ext install <path|package>   # install extension
8gent ext remove <name>            # uninstall
8gent ext list                     # show installed + status
8gent ext enable <name>            # re-enable disabled
8gent ext disable <name>           # disable without removing
```

---

## 5. Files to Create/Modify

**Create:**
- `packages/extensions/loader.ts` - jiti/Bun dynamic import, manifest validation (~150 lines)
- `packages/extensions/registry.ts` - installed extension state, enable/disable (~100 lines)
- `packages/extensions/types.ts` - all interfaces (~50 lines)

**Modify:**
- `packages/eight/agent.ts` - wire extension hooks into agent event loop (~20 lines)
- `packages/eight/tools.ts` - merge extension tools into tool set (~15 lines)
- `packages/permissions/policy-engine.ts` - per-extension sandbox creation (~20 lines)
- `bin/8gent.ts` - add `ext` subcommand (~30 lines)

## 6. Estimated Effort

3 new files (~300 lines), 4 modified files (~85 lines). Total: ~385 lines across 7 files.

Architecture reference: VSCode extensions model (manifest + activation events + sandboxed API surface). Also inspired by Cursor's custom tools and Aider's `/tool` registration.
