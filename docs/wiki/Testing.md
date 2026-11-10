# Testing

Everything here comes from `package.json`, `bunfig.toml` and `.github/workflows/ci.yml`. Tests use Bun's built-in runner.

## Commands

| Command | What it runs |
|:--------|:-------------|
| `bun run test` | `bun test packages/ apps/ tests/preload-temp-dirs.test.ts` |
| `bun test path/to/file.test.ts` | One test file |
| `bun test -t "name"` | Tests whose name matches (Bun flag) |
| `bun run test:security` | `bun test tests/security` |
| `bun run test:benchmarks` | `bun test benchmarks/` |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run typecheck:tui` | `tsc --noEmit -p apps/tui/tsconfig.json` |
| `bun run check:harness` | `tsc --noEmit -p tsconfig.harness.json` |
| `bun run lint` | `biome lint .` |
| `bun run check:biome` | Biome lint, format and import order |
| `bun run format:check` | Biome format check only |
| `bun run check:biome:fix` | Apply safe fixes and formatting |
| `bun scripts/local-first-gate.ts` | The principles gate (also `bun run check:local-first`) |
| `bun run smoke:fast` | `scripts/smoke.ts --skip-network` |

Use `bun run test` rather than bare `bun test` when you want what CI runs.

## Where tests live

Tests sit next to the code as `*.test.ts` files (for example under `packages/eight/`, `packages/permissions/`, `packages/daemon/`, `apps/tui/src/lib/`), in `__tests__/` folders, and in the top-level `tests/` folder. `tests/security/` holds security tests; `tests/windows/` holds Windows-specific ones. Gate tests are in `packages/ci/local-first-gate.test.ts`.

## How the suite is set up

`bunfig.toml` preloads files from `tests/` for every run:

- Tests run against a temporary `$HOME`, never your real one.
- Temp files go to one run-scoped directory that is removed after the run.
- Ink's CI detection is pinned off so render tests pass with or without `CI=true`.
- The local judge model is switched off, so tests do not probe or load one on your machine.

If your test writes files, use the helpers in `tests/` (such as `tests/temp-dirs.ts`) so the temp-dir check does not fail the run. `tests/scoped-test.ts` offers a `test` that runs inside a read-allow session scope for permission tests.

## What CI runs

On pull requests to `main`, `.github/workflows/ci.yml` installs with Bun, then runs, among other steps: the principles gate, `typecheck`, `typecheck:tui`, `check:harness`, `lint`, and `bun run test`. It also builds the bundles and runs packaging smoke tests. Other workflows cover Windows, macOS, Linux Docker and release checks (see `.github/workflows/`).

The Biome format and import-order checks gate the files your change touches, so run `bun run check:biome` before pushing.

## Caution when testing the TUI by hand

Do not run `pkill -f` against `bun run tui` or `apps/tui/src/index.tsx`. The `8gent` binary launches exactly that, so you would kill every live 8gent session on the machine, not just yours. Stop your own run with Ctrl+C or by killing only the process id you started.

## Principles gate

`bun scripts/local-first-gate.ts` checks that no default path sends data off the device and none runs or requests a system install. What it checks and how to add an entry: [docs/security/principles-gate.md](../security/principles-gate.md).
