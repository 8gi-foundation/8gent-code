# Quarantine: workspace-scanner

**Status:** quarantine - unreviewed, not wired into any index

**File:** `packages/tools/workspace-scanner.ts`

---

## What it does

Scans a project root directory and returns a structured manifest describing the technology stack, configuration surface, and entry points. Zero external dependencies.

| Function | Signature | Description |
|----------|-----------|-------------|
| `scanWorkspace` | `(rootDir: string) => WorkspaceManifest` | Full workspace scan - returns package managers, languages, frameworks, entry points, config files, and monorepo structure. |

`WorkspaceManifest` shape:
```ts
{
  rootDir: string;
  packageManagers: string[];   // npm, yarn, pnpm, bun, cargo, go mod, etc.
  languages: string[];         // TypeScript, Python, Go, Rust, etc.
  frameworks: string[];        // Next.js, React, Express, Hono, Tauri, etc.
  entryPoints: string[];       // index.ts, src/main.ts, bin/index.js, etc.
  configFiles: string[];       // tsconfig, eslint, vite, docker-compose, etc.
  monorepo: boolean;
  workspaces: string[];        // resolved workspace paths if monorepo
}
```

---

## CLI usage

```bash
# Scan current directory
bun packages/tools/workspace-scanner.ts

# Scan a specific path
bun packages/tools/workspace-scanner.ts /path/to/project
```

---

## Implementation notes

- Reads `package.json` deps to detect JS/TS frameworks - no string-walking source files.
- Package manager detection via lockfile presence (bun.lockb, yarn.lock, etc.).
- Monorepo detection via `package.json#workspaces` or `pnpm-workspace.yaml`.
- Workspace paths resolved one level deep from the globs.
- Config file matching handles prefix patterns (tsconfig.*.json, .env.*).
- All file access wrapped in try/catch - safe to run on partial or broken projects.

---

## Integration path

Not wired into `packages/tools/index.ts` or the agent tool registry.

Potential uses:
- Onboarding flow: auto-detect project type before first session to pre-load relevant context
- System prompt injection: `USER_CONTEXT_SEGMENT` in `packages/eight/prompts/system-prompt.ts`
- Worktree delegation: pass manifest to sub-agents in `packages/orchestration/` so they know the stack without re-scanning
- Benchmark harness: confirm detected frameworks match expected fixture before running category benchmarks
