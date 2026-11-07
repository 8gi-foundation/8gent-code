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
8gent ext approve-run <name>       # allow one unattended run (built, #47)
```

`enable` and `approve-run` are built (packages/extensions/process.ts); the others are not yet.

### Grants and unattended runs (#47)

- **The grant binds the program.** `.enabled` holds the sha256 of the manifest, of the
  resolved command file, and of every argument that is a file inside the extension folder.
  A bare command (`python3`) is looked up on the absolute PATH entries; its absolute path
  and its bytes are recorded and that absolute path is what is spawned. The check runs at
  load and again right before every spawn. Any mismatch leaves the extension off with
  "program changed since you enabled it; run 8gent ext enable <name> to review".
- **Tradeoff.** Upgrading the interpreter (`brew upgrade python`) also turns the extension
  off until it is enabled again. Not bound: files the program loads itself (imports,
  libraries, an interpreter reached through a `#!` line), and a change between the check
  and the exec.
- **Unattended means no, unless approved for that run.** CI, `EIGHT_HEADLESS`,
  `EIGHT_UNATTENDED` or no terminal start nothing. `8gent ext approve-run <name> [--ttl 1h]`
  asks at a terminal (default No) and prints `EIGHT_RUN_ID` and `EIGHT_EXT_APPROVAL`: an
  HMAC-SHA256 over (name, grant hash, run id, expiry), signed with a local key made on
  first use at `~/.8gent/keys/extension-approval.key` (0600). The host verifies it before
  every spawn; the first process to present a run id claims it, so the token does not work
  in a second run. Expiry defaults to 1 h, at most 24 h. The key never leaves the device, so
  a token minted on one machine does not verify on another. The prompt names the declared
  tools, which are then called without asking during that run. The policy engine still sees
  `attended: false`, plus `run_approved: true`, so a rule of your own on
  `attended equals false` keeps blocking approved runs.
- **Scripts live in the folder.** An argument naming an existing file outside the extension
  folder (an absolute `/tmp/x.py`) is refused at enable and at spawn: a file someone else can
  write cannot be bound.
- **Children end with the host.** On exit and on SIGINT, SIGTERM and SIGHUP every child is
  closed, then the signal is re-raised when nothing else listens. SIGKILL cannot be caught:
  the child then only sees its stdin close.
- **Not containment.** The child runs with the person's rights; out of process is crash
  isolation. Wrapping the spawn in the run-command sandbox is tracked in #47.

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
