# Quarantine: Plugin System

## Status: Design Phase

**Branch:** `quarantine/plugin-system`
**Created:** 2026-03-25

## What This Is

A plugin system that lets third parties extend Eight with tools, benchmarks, themes, and personas. Plugins are sandboxed, deny-by-default, and distributed via npm/GitHub.

## Files Added

| File | Purpose | Lines |
|------|---------|-------|
| `docs/PLUGIN-SPEC.md` | Full specification - manifest, lifecycle, security, distribution | ~200 |
| `packages/tools/plugin-loader.ts` | Basic loader - validate, register, activate, deactivate, sandbox | ~170 |
| `quarantine/plugin-system.md` | This file - quarantine tracking | ~40 |

## Key Design Decisions

1. **Deny-by-default security.** Plugins declare permissions in manifest, user must approve. No filesystem/network/env access unless explicitly granted.
2. **npm-compatible manifests.** Plugin metadata lives in `package.json` under an `eight` field. No custom config format.
3. **Context-mediated access.** Plugins never import Node/Bun modules directly. All I/O goes through `PluginContext` which enforces permission checks.
4. **Tool namespacing.** Plugin tools are prefixed `plugin:<name>:<tool>` to avoid collisions with core tools.
5. **Inactive by default.** Install does not activate. Explicit activation required.

## What is NOT Done

- CLI commands (`eight plugin install/activate/etc.`)
- Benchmark, theme, and persona registration handlers (stubs only)
- 8gent marketplace integration
- Hot reload for plugin development
- Plugin dependency resolution
- Integration with the policy engine
- Tests

## Graduation Criteria

To move out of quarantine:
1. At least one working example plugin (e.g., a simple tool plugin)
2. CLI commands wired into the TUI
3. Integration tests for sandbox enforcement
4. Policy engine integration for permission approval flow
5. Documentation reviewed and finalized
