# git-hooks-manager

**Tool name:** `git-hooks-manager`

**Description:**
Programmatically installs, removes, lists, and runs git hooks. Supports all common hook types (`pre-commit`, `pre-push`, `commit-msg`, `prepare-commit-msg`, `post-commit`, `post-merge`, `pre-rebase`). Includes hook chaining - compose multiple scripts under a single hook with `set -e` fail-fast semantics.

**Status:** quarantine

**Package path:** `packages/tools/git-hooks-manager.ts`

**Exports:** `GitHooks` class

## API surface

| Method | Purpose |
|--------|---------|
| `install(name, script)` | Install or overwrite a hook, chmod 755 |
| `remove(name)` | Remove a hook, returns bool indicating success |
| `list()` | All known hook types with installed status + content |
| `listInstalled()` | Installed hooks only |
| `run(name, args?, env?)` | Execute a hook directly, returns `{exitCode, stdout, stderr}` |
| `chain(name, scripts[])` | Combine multiple scripts under one hook with `set -e` |
| `isInstalled(name)` | Boolean check for a specific hook |
| `read(name)` | Raw content of an installed hook, or null |

## Integration path

1. Wire into `packages/eight/tools.ts` as a registered tool so the agent can manage hooks during sessions.
2. Use in `packages/validation/` healing loops - install a `pre-commit` hook that runs the checkpoint-verify cycle before commits are allowed.
3. Potential use in `packages/self-autonomy/` to install post-commit hooks that trigger post-session reflection automatically.

## Why quarantine

No integration with the agent loop yet. Core logic is self-contained and tested manually. Needs:
- Tool registration in `packages/eight/tools.ts`
- Tests in `packages/tools/__tests__/git-hooks-manager.test.ts`
- Decision on whether hook chaining belongs here or in `packages/validation/`
